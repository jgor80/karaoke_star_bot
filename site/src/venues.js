// Every bar that runs Oke Night. Each venue lives under its own path (okenight.com/<slug>/), with its
// own phone page, TV screen (/<slug>/tv), host page (/<slug>/host) and API (/<slug>/api/...).
//
// Data is kept apart in the one D1 database by a `venue` column (the slug) on every per-bar table.
// Rows written before venues existed, and anything the laptop sync writes without a venue, default to
// the first venue ("wbl"), so the original Welcome Back Lounge data needed no copying.
// Per-bar settings in host_config (host key, ntfy topic, tips, ...) use the plain key for "wbl" and
// "<slug>:<key>" for every other venue (see cfgKey / venueConfig).
//
// To add a bar: add an entry here (slug = lower case letters/digits, never reused or renamed, because
// it's in links, QR codes, the app and the database), deploy, then set its host key on /<slug>/host
// and put its slug in that bar's laptop sync config.
export const VENUES = [
  {
    slug: "wbl",
    name: "Welcome Back Lounge",
    venue: "Welcome Back Lounge", // same as name; schedule.js reads `venue`
    neighborhood: "Logan Square",
    address: "2423 N Milwaukee Ave",
    city: "Chicago, IL",
    lat: 41.9253,
    lng: -87.7003,
    tz: "America/Chicago",
    weekday: 0,        // Sunday (0 = Sunday ... 6 = Saturday)
    start: [21, 0],    // 9:00 pm
    hours: 4,          // regular end 1:00 am
    latest_hours: 5,   // can run until 2:00 am
    hours_label: "Sundays 9 PM – 1 AM Central",
    day_name: "Sunday",
    crowd_topic: "okenight-sundays", // public ntfy topic for "karaoke tonight" reminders
    host_default: "Bleacher Jeff",
  },
];

// Every bar needs a host_default (the host's singer name) so the host is left out of the most-songs and
// mic-time awards from the first night, before anyone sets a name on /host. Fail the deploy loudly if one is missing.
for (const v of VENUES) if (!String(v.host_default || "").trim()) throw new Error("venues.js: " + v.slug + " needs host_default (the host's singer name)");

export const DEFAULT_SLUG = VENUES[0].slug;
export const DEFAULT_VENUE = VENUES[0];
const BY_SLUG = new Map(VENUES.map((v) => [v.slug, v]));
export const venueBySlug = (slug) => BY_SLUG.get(String(slug || "").toLowerCase()) || null;

// What the venue picker and the app get from /api/venues (no settings, just where and when).
export function publicVenue(v) {
  return { slug: v.slug, name: v.name, neighborhood: v.neighborhood, address: v.address, city: v.city,
    lat: v.lat, lng: v.lng, tz: v.tz, hours_label: v.hours_label, day_name: v.day_name, path: "/" + v.slug + "/" };
}

// host_config key for this venue.
export const cfgKey = (v, k) => (v.slug === DEFAULT_SLUG ? k : v.slug + ":" + k);

// All host_config rows for one venue, keyed without the venue prefix.
export async function venueConfig(env, v) {
  const { results } = await env.DB.prepare("SELECT k, v FROM host_config").all();
  const out = {}, pre = v.slug + ":";
  results.forEach((r) => {
    if (v.slug === DEFAULT_SLUG) { if (!r.k.includes(":")) out[r.k] = r.v; }
    else if (r.k.startsWith(pre)) out[r.k.slice(pre.length)] = r.v;
  });
  return out;
}

// Adds the venue column to a table made before venues existed. Once per table per Worker instance;
// "duplicate column" just means it's already there.
const added = {};
export function ensureVenueColumn(env, table) {
  if (!added[table]) {
    added[table] = env.DB.prepare("ALTER TABLE " + table + " ADD COLUMN venue text not null default '" + DEFAULT_SLUG + "'").run()
      .catch((e) => { if (!/duplicate column/i.test(String(e && e.message || e))) { added[table] = null; throw e; } })
      .then(() => env.DB.prepare("CREATE INDEX IF NOT EXISTS " + table + "_venue ON " + table + " (venue)").run());
  }
  return added[table];
}
export const ensureVenueColumns = (env, tables) => Promise.all(tables.map((t) => ensureVenueColumn(env, t)));

// Distance in km between two points, for the nearest-venue picker.
export function km(aLat, aLng, bLat, bLng) {
  const r = Math.PI / 180, dLat = (bLat - aLat) * r, dLng = (bLng - aLng) * r;
  const h = Math.sin(dLat / 2) ** 2 + Math.cos(aLat * r) * Math.cos(bLat * r) * Math.sin(dLng / 2) ** 2;
  return 12742 * Math.asin(Math.sqrt(h));
}
