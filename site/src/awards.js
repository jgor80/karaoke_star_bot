/* Night awards ("The Mics"), shared by the phone page (/) and the TV screen (/tv).
 * Pure functions over plays rows {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s},
 * sorted by played_at. No dependencies. Exposed as window.OkeAwards.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const mmss = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const localHour = (ts) => new Date(ts * 1000).getHours();
  const songLine = (p) => (p.title ? "“" + p.title + "”" + (p.artist ? " · " + p.artist : "") : "a mystery song");

  const ICON = { debut: "🎤", regular: "🎟️", lifer: "🏠", hattrick: "🎩", hopper: "🕰️", timelord: "⏳", oldie: "📻", fresh: "🌱", marathon: "🏃", sprint: "⚡",
    duet: "👯", broken: "💿", signature: "✍️", loyal: "💖", brit: "🇬🇧", punk: "🤘", owl: "🦉", opener: "🚪", closer: "🌙", trend: "📈",
    mvp: "🎤", dejavu: "🔁", speed: "⚡", time: "🕰️", squad: "👯", open: "🚪", last: "🌙", artist: "🎸", decade: "📼",
    "s-mvp": "🏆", "s-loyal": "📅", "s-mic": "⏱️", "s-badges": "🎖️", "s-range": "🌈", "s-duet": "👯", "s-onesong": "🔁", "s-crate": "📦", "s-trend": "📈" };
  const icon = (id) => ICON[id] || "⭐";

  function groupSize(name) {
    const n = key(name);
    if (/^table\s*\d+/.test(n)) return 4;
    return n.split(/\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/).filter(Boolean).length;
  }

  // One count per person. `people` is KaraokeFun.badgesAll's map (merged names, duets credited to members);
  // without it, fall back to the name as typed. `all` is the full plays array (lets us skip filtering).
  function personTotals(rows, people, all) {
    const inRows = new Set(rows), out = [];
    if (people && people.size) {
      people.forEach((e) => { const r = rows === all ? e.rows : e.rows.filter((p) => inRows.has(p)); if (r.length) out.push({ k: e.key, name: e.name, rows: r }); });
    } else {
      const by = new Map(); rows.forEach((p) => { const k = key(p.singer); if (!k) return; const e = by.get(k) || { k, name: clean(p.singer), rows: [] }; e.rows.push(p); by.set(k, e); });
      out.push(...by.values());
    }
    out.forEach((e) => { e.n = e.rows.length; e.secs = e.rows.reduce((a, p) => a + (p.length_s || 0), 0); e.nights = new Set(e.rows.map((p) => p.night)); });
    return out.sort((a, b) => b.n - a.n || b.nights.size - a.nights.size || b.secs - a.secs || a.name.localeCompare(b.name));
  }

  // -> [{id, label, who, what, stat, headline?}]; `totals` is rows -> personTotals list (for Mic Hog)
  function awardsFor(rows, totals) {
    const out = [];
    const songs = rows.filter((p) => p.title);
    const timed = songs.filter((p) => p.length_s);
    const dated = songs.filter((p) => p.release_year);
    const mvp = (totals || ((r) => personTotals(r)))(rows)[0];
    if (mvp && mvp.n > 1) out.push({ id: "mvp", headline: true, label: "Mic Hog", who: mvp.name, what: "Most songs of the night", stat: mvp.n + " songs · " + mmss(mvp.secs) + " on the mic" });
    const rep = new Map();
    songs.forEach((p) => { const k = key(p.singer) + "|" + key(p.title); const e = rep.get(k) || { p, n: 0 }; e.n++; rep.set(k, e); });
    const br = [...rep.values()].filter((e) => e.n > 1 && key(e.p.singer)).sort((a, b) => b.n - a.n)[0];
    if (br) out.push({ id: "broken", headline: true, label: "Broken Record", who: clean(br.p.singer), what: songLine(br.p), stat: br.n + " times in one night" });
    const byTitle = new Map();
    songs.forEach((p) => { const k = key(p.title); const e = byTitle.get(k) || []; e.push(p); byTitle.set(k, e); });
    const dv = [...byTitle.values()].filter((l) => new Set(l.map((p) => key(p.singer) + "|" + key(p.artist))).size > 1).sort((a, b) => b.length - a.length)[0];
    if (dv) { const names = [...new Set(dv.map((p) => clean(p.singer) || "someone"))];
      out.push({ id: "dejavu", label: "Déjà Vu", who: names.join(" + "), what: "“" + dv[0].title + "”, more than once", stat: dv.length + " plays" + (new Set(dv.map((p) => key(p.artist))).size > 1 ? ", different versions" : "") }); }
    if (timed.length) {
      const long = timed.reduce((a, b) => (b.length_s > a.length_s ? b : a));
      const short = timed.reduce((a, b) => (b.length_s < a.length_s ? b : a));
      out.push({ id: "marathon", headline: !br, label: "Marathon", who: clean(long.singer) || "Someone", what: songLine(long), stat: mmss(long.length_s) + " long" });
      if (short !== long) out.push({ id: "speed", label: "Speed Run", who: clean(short.singer) || "Someone", what: songLine(short), stat: "over in " + mmss(short.length_s) });
    }
    if (dated.length) {
      const old = dated.reduce((a, b) => (b.release_year < a.release_year ? b : a));
      const fresh = dated.reduce((a, b) => (b.release_year > a.release_year ? b : a));
      out.push({ id: "time", headline: true, label: "Time Traveler", who: clean(old.singer) || "Someone", what: songLine(old), stat: "from " + old.release_year });
      if (fresh !== old) out.push({ id: "fresh", label: "Fresh Drop", who: clean(fresh.singer) || "Someone", what: songLine(fresh), stat: "from " + fresh.release_year });
    }
    const sq = rows.filter((p) => key(p.singer)).map((p) => ({ p, n: groupSize(p.singer) })).sort((a, b) => b.n - a.n)[0];
    if (sq && sq.n > 1) out.push({ id: "squad", label: "Squad Goals", who: clean(sq.p.singer), what: songLine(sq.p), stat: /^table/i.test(sq.p.singer.trim()) ? "a whole table" : sq.n + " voices" });
    const first = rows[0], last = rows[rows.length - 1];
    if (first) out.push({ id: "open", label: "Opening Act", who: clean(first.singer) || "Someone", what: songLine(first), stat: "first brave soul" });
    if (last && last !== first) out.push({ id: "last", label: "Last Call", who: clean(last.singer) || "Someone", what: songLine(last), stat: "closed the night" });
    const art = new Map();
    songs.forEach((p) => { if (!p.artist) return; const k = key(p.artist); const e = art.get(k) || { name: p.artist, n: 0, who: new Set() }; e.n++; e.who.add(clean(p.singer)); art.set(k, e); });
    const top = [...art.values()].sort((a, b) => b.n - a.n)[0];
    if (top && top.n > 1) out.push({ id: "artist", label: "Artist of the Night", who: top.name, what: "Sung by " + [...top.who].filter(Boolean).join(", "), stat: top.n + " songs" });
    const dec = new Map();
    dated.forEach((p) => { const d = Math.floor(p.release_year / 10) * 10; dec.set(d, (dec.get(d) || 0) + 1); });
    const td = [...dec.entries()].sort((a, b) => b[1] - a[1])[0];
    if (td) out.push({ id: "decade", label: "Decade of the Night", who: "The " + String(td[0]).slice(2) + "s", what: Math.round((100 * td[1]) / dated.length) + "% of songs with a known year", stat: td[1] + " songs" });
    return out;
  }

  function tallyFor(rows) {
    const singers = new Set(rows.map((p) => key(p.singer)).filter(Boolean)).size;
    const secs = rows.reduce((s, p) => s + (p.length_s || 0), 0);
    const hours = new Map(); rows.forEach((p) => { const h = localHour(p.played_at); hours.set(h, (hours.get(h) || 0) + 1); });
    const ph = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
    const fmtH = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    return { songs: rows.length, singers, minutes: Math.round(secs / 60), peak: ph ? fmtH(ph[0]) : "—" };
  }

  global.OkeAwards = { ICON, icon, groupSize, personTotals, awardsFor, tallyFor, songLine };
})(typeof window !== "undefined" ? window : globalThis);
