// Fast pass: tip the host to get moved up the line. Website only (never in the phone app: Apple 3.1.1).
// The site can't touch the karaoke app's queue, so nothing moves on its own. A phone asks for a pass and pays
// the tip in the host's own payment app; the host checks the money came in, taps Paid on /host and moves the
// slip up in the karaoke app. The order is always the KJ's call.
//
// POST /api/fastpass {name, dev}            -> {ok, id}        (one waiting pass per phone, limits per night)
// GET  /api/fastpass?ids=1,2                -> {passes: [{id, status}]}  so a phone can show its own pass
// fastPassBoard(env, venue)                 -> {fast_passes: [{singer, at}]} paid passes tonight, for /api/plays
// hostFastPasses(env, venue)                -> waiting + handled passes tonight, for /api/host
// hostFastPassAction(env, body, venue)      -> {action: "fastpass_set", id, status: "paid"|"no"|"waiting"} | {action: "fastpass_remove", id}
//
// Waiting passes (names a stranger typed) only go to the host. Only names the host marked Paid are shown to the crowd.
import { cleanName } from "./reactions_api.js";
import { draftNight } from "./drafts_api.js";
import { DEFAULT_VENUE, cfgKey, ensureVenueColumn } from "./venues.js";
import { networkHash } from "./net.js";
import { okOrigin } from "./origins.js";
import { hostPush } from "./push_api.js";

export const FP_LIMITS = { perPhone: 3, perIp: 25, pushesPerHour: 20 }; // per night
export const DEFAULT_FASTPASS = 10; // dollars; the host changes it (0 = off) on /host
const STATUSES = ["waiting", "paid", "no"];

const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS fast_passes (
    id integer primary key autoincrement, night text not null, singer text not null,
    device_id text not null, ip_hash text, status text not null default 'waiting',
    created_at integer not null, updated_at integer not null, venue text not null default 'wbl')`,
  "CREATE INDEX IF NOT EXISTS fast_passes_night ON fast_passes (venue, night, status)",
  "CREATE INDEX IF NOT EXISTS fast_passes_dev ON fast_passes (device_id, night)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).then(() => ensureVenueColumn(env, "fast_passes")).catch((e) => { ready = null; throw e; });
  return ready;
}

const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });
const nowS = () => Math.floor(Date.now() / 1000);

// The price from host_config `fastpass` (whole dollars, 0 = off). Used by tipsFrom in secrets_api.js.
export function fastPassPrice(v) {
  if (v === undefined || v === null || v === "") return DEFAULT_FASTPASS;
  const n = Math.round(Number(v));
  return n >= 0 && n <= 200 ? n : DEFAULT_FASTPASS;
}

async function price(env, venue) {
  const r = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "fastpass")).first().catch(() => null);
  return fastPassPrice(r ? r.v : undefined);
}

export async function handleFastPass(req, env, ctx, venue = DEFAULT_VENUE) {
  await ensure(env);
  const url = new URL(req.url);
  if (req.method === "GET") {
    const ids = (url.searchParams.get("ids") || "").split(",").map(Number).filter((n) => n > 0).slice(0, 10);
    if (!ids.length) return json({ passes: [] });
    const { results } = await env.DB.prepare("SELECT id, status FROM fast_passes WHERE venue = ? AND id IN (" + ids.map(() => "?").join(",") + ")").bind(venue.slug, ...ids).all();
    return json({ passes: results });
  }
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  if (!okOrigin(req, url)) return json({ error: "Wrong site" }, 403);
  let b;
  try { b = await req.json(); } catch (e) { return json({ error: "bad json" }, 400); }
  const name = cleanName(b.name), dev = String(b.dev || "");
  if (!name) return json({ error: "Type the name on your slip." }, 400);
  if (!/^[a-f0-9]{32}$/.test(dev)) return json({ error: "bad device" }, 400);
  const amount = await price(env, venue);
  if (!amount) return json({ error: "Fast passes are off tonight." }, 403);
  const night = draftNight(nowS(), venue), now = nowS();
  const ipHash = await networkHash(env, req, "fastpass", night);
  // Same phone asking again while its pass is still waiting: reuse it (a new name replaces the old one).
  const mine = await env.DB.prepare("SELECT id FROM fast_passes WHERE venue = ? AND night = ? AND device_id = ? AND status = 'waiting' ORDER BY id DESC LIMIT 1").bind(venue.slug, night, dev).first();
  if (mine) {
    await env.DB.prepare("UPDATE fast_passes SET singer = ?, updated_at = ? WHERE id = ?").bind(name, now, mine.id).run();
    return json({ ok: true, id: mine.id, amount });
  }
  // Insert only under the limits, in one statement so phones asking at once can't slip past them.
  const ins = await env.DB.prepare(
    "INSERT INTO fast_passes (night, singer, device_id, ip_hash, created_at, updated_at, venue) SELECT ?1, ?2, ?3, ?4, ?5, ?5, ?6" +
    " WHERE (SELECT count(*) FROM fast_passes WHERE device_id = ?3 AND night = ?1) < ?7" +
    " AND (?4 IS NULL OR (SELECT count(*) FROM fast_passes WHERE ip_hash = ?4 AND night = ?1) < ?8)")
    .bind(night, name, dev, ipHash, now, venue.slug, FP_LIMITS.perPhone, FP_LIMITS.perIp).run();
  if (!ins.meta.changes) return json({ error: "That’s plenty of fast passes for tonight. Talk to the host at the booth." }, 429);
  const id = ins.meta.last_row_id;
  ctx.waitUntil((async () => {
    const recent = await env.DB.prepare("SELECT count(*) AS n FROM fast_passes WHERE venue = ? AND created_at > ?").bind(venue.slug, now - 3600).first();
    if (recent && recent.n > FP_LIMITS.pushesPerHour) return;
    const msg = name + " wants a fast pass ($" + amount + "). Check your tips, then tap Paid on okenight.com/" + venue.slug + "/host";
    await hostPush(env, venue, "⚡ Fast pass", msg);
    const t = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(venue, "ntfy_topic")).first().catch(() => null);
    if (t && t.v) await fetch("https://ntfy.sh/" + t.v, { method: "POST", body: msg, headers: { Title: "Fast pass", Tags: "zap" } });
  })().catch(() => {}));
  return json({ ok: true, id, amount });
}

// For /api/plays: who has a paid fast pass tonight (the ⚡ on the phone's line and the TV's Up next).
export async function fastPassBoard(env, venue = DEFAULT_VENUE) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT singer, updated_at AS at FROM fast_passes WHERE venue = ? AND night = ? AND status = 'paid' ORDER BY updated_at")
      .bind(venue.slug, draftNight(nowS(), venue)).all();
    return { fast_passes: results };
  } catch (e) { return { fast_passes: [] }; }
}

// For /api/host: tonight's passes, waiting ones first.
export async function hostFastPasses(env, venue = DEFAULT_VENUE) {
  await ensure(env);
  const { results } = await env.DB.prepare(
    "SELECT id, singer, status, created_at, updated_at FROM fast_passes WHERE venue = ? AND night = ? ORDER BY status = 'waiting' DESC, updated_at DESC LIMIT 100")
    .bind(venue.slug, draftNight(nowS(), venue)).all();
  return { fast_passes: results, fastpass_price: await price(env, venue) };
}

export async function hostFastPassAction(env, body, venue = DEFAULT_VENUE) {
  await ensure(env);
  const id = Number(body.id) || 0;
  if (body.action === "fastpass_set") {
    if (!STATUSES.includes(body.status)) return { error: "bad status" };
    await env.DB.prepare("UPDATE fast_passes SET status = ?, updated_at = ? WHERE id = ? AND venue = ?").bind(body.status, nowS(), id, venue.slug).run();
  } else if (body.action === "fastpass_remove") {
    await env.DB.prepare("DELETE FROM fast_passes WHERE id = ? AND venue = ?").bind(id, venue.slug).run();
  } else if (body.action === "fastpass_price") {
    const n = Math.round(Number(body.amount));
    if (!(n >= 0 && n <= 200)) return { error: "Pick a price from $0 (off) to $200." };
    await env.DB.prepare("INSERT OR REPLACE INTO host_config (k, v) VALUES (?, ?)").bind(cfgKey(venue, "fastpass"), String(n)).run();
  } else return { error: "unknown action" };
  return { ok: true };
}
