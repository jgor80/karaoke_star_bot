// "Bring Oke Night to your bar" form on the intro page (okenight.com/).
// POST /api/lead {name, bar, city, contact, role, note, dev} -> {ok}
// Saved to D1 (leads) and listed on the first venue's /host page (hostLeads). The push to that venue's ntfy
// topic only says a lead came in: ntfy.sh topics are public to anyone who knows the name, so the contact
// details stay in D1. Nothing here is ever shown publicly. Limited per network per day so the form can't be used to flood the owner's phone.
import { DEFAULT_VENUE, cfgKey } from "./venues.js";
import { cleanText } from "./requests_api.js";
import { networkHash } from "./net.js";

const PER_IP_PER_DAY = 5;
const SCHEMA = [
  `CREATE TABLE IF NOT EXISTS leads (
    id integer primary key autoincrement, name text, bar text not null, city text, contact text not null,
    role text, note text, ip_hash text, day text not null, created_at integer not null)`,
  "CREATE INDEX IF NOT EXISTS leads_ip ON leads (ip_hash, day)",
];
let ready = null;
function ensure(env) {
  if (!ready) ready = env.DB.batch(SCHEMA.map((s) => env.DB.prepare(s))).catch((e) => { ready = null; throw e; });
  return ready;
}
const json = (body, status = 200) =>
  new Response(JSON.stringify(body), { status, headers: { "content-type": "application/json; charset=utf-8", "cache-control": "no-store" } });

export async function handleLead(req, env, ctx) {
  if (req.method !== "POST") return json({ error: "POST only" }, 405);
  const url = new URL(req.url), origin = req.headers.get("origin");
  if (origin && new URL(origin).host !== url.host) return json({ error: "Wrong site" }, 403);
  let b;
  try { b = JSON.parse((await req.text()).slice(0, 4000)); } catch (e) { return json({ error: "Bad JSON" }, 400); }
  if (b.website) return json({ ok: true }); // hidden field only bots fill in
  const lead = {
    name: cleanText(b.name, 60), bar: cleanText(b.bar, 80), city: cleanText(b.city, 60),
    contact: cleanText(b.contact, 100), role: cleanText(b.role, 30), note: cleanText(b.note, 600),
  };
  if (lead.bar.length < 2) return json({ error: "What’s the bar called?" }, 400);
  if (lead.contact.length < 5) return json({ error: "Add an email or phone number so we can reach you." }, 400);

  await ensure(env);
  const day = new Date().toISOString().slice(0, 10), now = Math.floor(Date.now() / 1000);
  const ipHash = await networkHash(env, req, "lead", day);
  const ins = await env.DB.prepare(`INSERT INTO leads (name, bar, city, contact, role, note, ip_hash, day, created_at)
      SELECT ?1, ?2, ?3, ?4, ?5, ?6, ?7, ?8, ?9
      WHERE ?7 IS NULL OR (SELECT count(*) FROM leads WHERE ip_hash = ?7 AND day = ?8) < ?10`)
    .bind(lead.name || null, lead.bar, lead.city || null, lead.contact, lead.role || null, lead.note || null, ipHash, day, now, PER_IP_PER_DAY).run();
  if (!ins.meta.changes) return json({ error: "Thanks, we already have a few messages from you today. We’ll be in touch!" }, 429);

  ctx.waitUntil((async () => {
    const t = await env.DB.prepare("SELECT v FROM host_config WHERE k = ?").bind(cfgKey(DEFAULT_VENUE, "ntfy_topic")).first().catch(() => null);
    if (!t || !t.v) return;
    const body = lead.bar + (lead.city ? " (" + lead.city + ")" : "") + "\nDetails on okenight.com/" + DEFAULT_VENUE.slug + "/host";
    await fetch("https://ntfy.sh/" + t.v, { method: "POST", body, headers: { Title: "New bar interested in Oke Night", Tags: "beers" } });
  })().catch(() => {}));
  return json({ ok: true });
}

// For the first venue's /api/host: the newest leads. The owner runs that venue, so that's where they're read.
export async function hostLeads(env) {
  try {
    await ensure(env);
    const { results } = await env.DB.prepare("SELECT id, name, bar, city, contact, role, note, created_at FROM leads ORDER BY id DESC LIMIT 100").all();
    return { leads: results };
  } catch (e) {
    return { leads: [] };
  }
}

// lead_remove {id}: delete a lead once it's been handled (it holds someone's contact details).
export async function hostLeadAction(env, body) {
  await ensure(env);
  if (body.action !== "lead_remove") return { error: "unknown action" };
  await env.DB.prepare("DELETE FROM leads WHERE id = ?").bind(Number(body.id) || 0).run();
  return { ok: true };
}
