/* Night awards ("The Mics"), shared by the phone page (/) and the TV screen (/tv).
 * Pure functions over plays rows {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s},
 * sorted by played_at. No dependencies. Exposed as window.OkeAwards.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const mmss = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  // Hour and minute at the venue (Central time), whatever time zone the phone or TV is set to.
  const VENUE_TZ = (typeof window !== "undefined" && window.OKE_VENUE && window.OKE_VENUE.tz) || "America/Chicago"; // the bar's time zone (venues.js)
  let venueFmt = null;
  const venueHM = (ts) => {
    try {
      venueFmt = venueFmt || new Intl.DateTimeFormat("en-US", { timeZone: VENUE_TZ, hour: "numeric", minute: "numeric", hourCycle: "h23" });
      const parts = venueFmt.formatToParts(new Date(ts * 1000)), get = (t) => Number((parts.find((x) => x.type === t) || {}).value);
      return { h: get("hour") % 24, m: get("minute") };
    } catch (e) { const d = new Date(ts * 1000); return { h: d.getHours(), m: d.getMinutes() }; }
  };
  const localHour = (ts) => venueHM(ts).h;
  const songLine = (p) => (p.title ? "“" + p.title + "”" + (p.artist ? " · " + p.artist : "") : "a mystery song");

  const ICON = { debut: "🎤", regular: "🎟️", lifer: "🏠", streak3: "🔥", streak5: "🔥", streak10: "🫁", hattrick: "🎩", hopper: "🕰️", timelord: "⏳", oldie: "📻", fresh: "🌱", marathon: "🏃", sprint: "⚡",
    duet: "👯", plusone: "🫶", broken: "💿", signature: "✍️", loyal: "💖", brit: "🇬🇧", punk: "🤘", owl: "🦉", opener: "🚪", closer: "🌙", trend: "📈",
    mvp: "🎤", dejavu: "🔁", speed: "⚡", time: "🕰️", squad: "👯", open: "🚪", last: "🌙", artist: "🎸", decade: "📼",
    crowd: "👑", loud: "👏", "s-loud": "📢", "rx-micdrop": "🎤", "rx-encore": "🔁", "rx-tomato": "🍅", "rx-pitch": "💪", "rx-snooze": "😴", "rx-key": "📈", "rx-hype": "📣", "rx-critic": "🧐",
    "b-crowd": "🔥", "b-drop": "🎤", "b-encore": "🔁", "b-tomato": "🍅", "s-crowd": "👑", "s-hype": "📣",
    "s-mvp": "🏆", "s-loyal": "📅", "s-mic": "⏱️", "s-badges": "🎖️", "s-range": "🌈", "s-duet": "👯", "s-onesong": "🔁", "s-crate": "📦", "s-trend": "📈" };
  // Genre badge icons come from KaraokeFun.GENRES (fun.js) when it's loaded.
  const icon = (id) => ICON[id] || ((global.KaraokeFun && (global.KaraokeFun.GENRES.find((g) => g.id === id) || {}).icon)) || (id === "g-hopper" ? "🎛️" : "⭐");

  // ---------- live emoji reactions ----------
  // Keep keys in sync with REACTION_KEYS in reactions_api.js. "hype" ones count toward Crowd Favorite.
  const REACTIONS = [
    { k: "fire", e: "🔥", name: "Fire", hype: true },
    { k: "micdrop", e: "🎤", name: "Mic drop", hype: true },
    { k: "encore", e: "🔁", name: "Encore", hype: true },
    { k: "chills", e: "😭", name: "Chills", hype: true },
    { k: "dance", e: "💃", name: "Dance", hype: true },
    { k: "keychange", e: "📈", name: "Key change", hype: true },
    // The teasing ones laugh with the singer, never at them (Jeff, 2026-11-18). Keys stay for old taps.
    { k: "cringe", e: "😅", name: "Bold choice" },
    { k: "offkey", e: "🎶", name: "Own key" },
    { k: "tomato", e: "🍅", name: "Tomato" },
    { k: "snooze", e: "😴", name: "Slow burn" },
  ];
  const HYPE = new Set(REACTIONS.filter((x) => x.hype).map((x) => x.k));
  const ROAST = new Set(["cringe", "offkey", "tomato", "snooze"]);
  const sumOf = (c, set) => Object.entries(c || {}).reduce((a, [k, n]) => a + (!set || set.has(k) ? n : 0), 0);
  // /api/plays {reactions: [{play, r, n}], reactors: [{night, who, r, n}], crowd: [{play, db, at}]}
  //   -> {bySong: Map(uuid -> {r: n}), reactors, crowd: Map(uuid -> {db, at})}
  function reactionIndex(data) {
    const bySong = new Map(), crowd = new Map();
    ((data && data.reactions) || []).forEach((x) => { const c = bySong.get(x.play) || {}; c[x.r] = (c[x.r] || 0) + Number(x.n); bySong.set(x.play, c); });
    ((data && data.crowd) || []).forEach((x) => crowd.set(x.play, { db: Number(x.db), at: Number(x.at) }));
    return { bySong, reactors: ((data && data.reactors) || []).map((x) => ({ ...x, n: Number(x.n) })), crowd };
  }

  // ---------- crowd meter (applause loudness after each song, see crowd_api.js) ----------
  // A song's score is how many dB the applause rose over the room's chatter. Shown as 0-10: 25 dB over = 10.
  const CROWD_DB_PER_POINT = 2.5, CROWD_MIN_DB = 6; // below 6 dB over chatter nobody really clapped
  const crowdScore = (db) => Math.max(0, Math.min(10, Math.round(Number(db) / CROWD_DB_PER_POINT)));
  const crowdOf = (reax, p) => (reax && reax.crowd && p && p.uuid && reax.crowd.get(p.uuid)) || null;
  function crowdAwards(rows, reax, season) {
    const scored = rows.map((p) => ({ p, c: crowdOf(reax, p) })).filter((x) => x.c && x.c.db >= CROWD_MIN_DB);
    if (!scored.length) return [];
    const top = scored.reduce((a, b) => (b.c.db > a.c.db ? b : a));
    return [{ id: season ? "s-loud" : "loud", headline: !season, label: season ? "Biggest Ovation of the Season" : "Loudest Crowd",
      who: clean(top.p.singer) || "Someone", what: songLine(top.p), stat: "👏 " + crowdScore(top.c.db) + "/10 on the crowd meter" }];
  }

  // Crowd awards for a set of plays. Songs and singers come from the plays, reactors from who tapped.
  function reactionAwards(rows, reax, season) {
    const out = crowdAwards(rows, reax, season);
    if (!reax || !reax.bySong.size) return out;
    const songs = rows.filter((p) => p.uuid && reax.bySong.has(p.uuid)).map((p) => ({ p, c: reax.bySong.get(p.uuid) }));
    if (!songs.length) return out;
    const bySinger = new Map();
    songs.forEach(({ p, c }) => { const k = key(p.singer); if (!k) return; const e = bySinger.get(k) || { name: clean(p.singer), c: {}, songs: 0 }; e.songs++;
      Object.entries(c).forEach(([r, n]) => { e.c[r] = (e.c[r] || 0) + n; }); bySinger.set(k, e); });
    const topSinger = (score, min) => [...bySinger.values()].map((e) => ({ e, v: score(e.c) })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v || a.e.songs - b.e.songs)[0];
    const topSong = (score, min) => songs.map((x) => ({ ...x, v: score(x.c) })).filter((x) => x.v >= min).sort((a, b) => b.v - a.v || a.p.played_at - b.p.played_at)[0];
    const pl = (n, w) => n + " " + w + (n === 1 ? "" : "s");
    let w;
    if ((w = topSinger((c) => sumOf(c, HYPE), 3))) out.push({ id: season ? "s-crowd" : "crowd", headline: !season, label: season ? "Season Crowd Favorite" : "Crowd Favorite", who: w.e.name,
      what: season ? "Most hype reactions all season" : "The room went wild", stat: pl(w.v, "hype reaction") });
    if (season) {
      const nights = new Set(rows.map((p) => p.night)), givers = new Map();
      reax.reactors.forEach((x) => { if (!nights.has(x.night)) return; givers.set(x.who, (givers.get(x.who) || 0) + x.n); });
      const g = [...givers.entries()].filter(([who]) => !/^Anon /.test(who)).sort((a, b) => b[1] - a[1])[0];
      if (g && g[1] >= 10) out.push({ id: "s-hype", label: "Loudest Phone", who: g[0], what: "Most reactions sent all season", stat: pl(g[1], "reaction") });
      return out;
    }
    const one = (r) => (c) => c[r] || 0;
    if ((w = topSong(one("micdrop"), 2))) out.push({ id: "rx-micdrop", label: "Mic Drop Moment", who: clean(w.p.singer) || "Someone", what: songLine(w.p), stat: pl(w.v, "mic drop") });
    if ((w = topSong(one("encore"), 2))) out.push({ id: "rx-encore", label: "Encore! Encore!", who: clean(w.p.singer) || "Someone", what: songLine(w.p), stat: w.v + " begged for more" });
    if ((w = topSong(one("keychange"), 2))) out.push({ id: "rx-key", label: "Truck Driver’s Gear Change", who: clean(w.p.singer) || "Someone", what: songLine(w.p), stat: pl(w.v, "key change") + " called" });
    if ((w = topSinger(one("tomato"), 2))) out.push({ id: "rx-tomato", label: "Farmers Market Favorite", who: w.e.name, what: "The crowd’s favorite target, all in love", stat: pl(w.v, "tomato").replace("tomatos", "tomatoes") + " of pure affection" });
    if ((w = topSinger((c) => (c.offkey || 0) + (c.cringe || 0), 2))) out.push({ id: "rx-pitch", label: "Fearless Notes Award", who: w.e.name, what: "Went for every note, and the room loved it", stat: pl(w.v, "brave note") });
    if ((w = topSong(one("snooze"), 2))) out.push({ id: "rx-snooze", label: "Lullaby Legend", who: clean(w.p.singer) || "Someone", what: songLine(w.p), stat: "So smooth " + w.v + (w.v === 1 ? " person" : " people") + " got cozy" });
    const night = rows[0] && rows[0].night, giv = new Map(), crit = new Map();
    reax.reactors.forEach((x) => { if (x.night !== night) return; giv.set(x.who, (giv.get(x.who) || 0) + x.n); if (ROAST.has(x.r)) crit.set(x.who, (crit.get(x.who) || 0) + x.n); });
    const best = (m, min) => [...m.entries()].filter(([who, n]) => n >= min && !/^Anon /.test(who)).sort((a, b) => b[1] - a[1])[0];
    if ((w = best(giv, 5))) out.push({ id: "rx-hype", label: "Hype Machine", who: w[0], what: "Sent the most reactions", stat: pl(w[1], "reaction") });
    if ((w = best(crit, 3))) out.push({ id: "rx-critic", label: "Friendliest Heckler", who: w[0], what: "Most playful tomatoes, snoozes and cringes sent", stat: pl(w[1], "friendly roast") });
    return out;
  }

  // The host runs the show and is on the mic all night, so they never win the volume awards
  // (most songs, most mic time, most nights). Set from /api/plays "host"; empty means no host known.
  // Matched loosely, like the site's name merging (fun.js canonicalize), so "Bleacher Jeff (fin)",
  // "bleacherjeff", "Vincent Vega (Bleacher Jeff)" and accented spellings are still the host even when
  // fun.js didn't load and names weren't merged first.
  let HOST = "";
  const norm = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^a-z0-9]/g, "");
  function setHost(name) { HOST = norm(name); }
  function isHost(name) {
    if (!HOST || !name) return false;
    const s = String(name), paren = /\(([^)]+)\)/.exec(s);
    return norm(s) === HOST || norm(s.replace(/\([^)]*\)/g, " ")) === HOST || (!!paren && norm(paren[1]) === HOST);
  }

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

  // -> [{id, label, who, what, stat, headline?}]; `totals` is rows -> personTotals list (for Mic Hog),
  // `reax` is reactionIndex(...) for the crowd awards (optional).
  function awardsFor(rows, totals, reax) {
    const out = [];
    const songs = rows.filter((p) => p.title);
    const timed = songs.filter((p) => p.length_s);
    const dated = songs.filter((p) => p.release_year);
    const mvp = (totals || ((r) => personTotals(r)))(rows).find((e) => !isHost(e.name));
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
    // Last Call only once the night is over (no song for 20 minutes); while it's live it's just whoever sang last.
    if (last && last !== first && Date.now() / 1000 - last.played_at > 20 * 60) out.push({ id: "last", label: "Last Call", who: clean(last.singer) || "Someone", what: songLine(last), stat: "closed the night" });
    const art = new Map();
    songs.forEach((p) => { if (!p.artist) return; const k = key(p.artist); const e = art.get(k) || { name: p.artist, n: 0, who: new Set() }; e.n++; e.who.add(clean(p.singer)); art.set(k, e); });
    const top = [...art.values()].sort((a, b) => b.n - a.n)[0];
    if (top && top.n > 1) out.push({ id: "artist", label: "Artist of the Night", who: top.name, what: "Sung by " + [...top.who].filter(Boolean).join(", "), stat: top.n + " songs" });
    const dec = new Map();
    dated.forEach((p) => { const d = Math.floor(p.release_year / 10) * 10; dec.set(d, (dec.get(d) || 0) + 1); });
    const td = [...dec.entries()].sort((a, b) => b[1] - a[1])[0];
    if (td) out.push({ id: "decade", label: "Decade of the Night", who: "The " + String(td[0]).slice(2) + "s", what: Math.round((100 * td[1]) / dated.length) + "% of songs with a known year", stat: td[1] + " songs" });
    out.push(...reactionAwards(rows, reax));
    return out;
  }

  // One short line per award on what it means and how it's won, shown on every award card (phone + TV).
  const HOW = {
    mvp: "Most songs of the night", broken: "Same song twice in one night", dejavu: "Same song, sung by different people",
    marathon: "Longest song of the night", speed: "Shortest song of the night", time: "Oldest song of the night",
    fresh: "Newest song of the night", squad: "Most voices on one song", open: "First song of the night",
    last: "Last song of the night", artist: "Most-sung artist tonight", decade: "Most-sung decade tonight",
    loud: "Loudest crowd meter cheer tonight", "s-loud": "Loudest crowd meter cheer all season",
    crowd: "Most hype reactions tonight", "s-crowd": "Most hype reactions all season", "s-hype": "Sent the most reactions all season",
    "rx-micdrop": "Most 🎤 mic drops on one song", "rx-encore": "Most 🔁 encore taps on one song",
    "rx-key": "Most 📈 key change calls on one song", "rx-tomato": "Most 🍅 tomatoes, thrown with love",
    "rx-pitch": "Most 🎶 own key and 😅 bold choice taps", "rx-snooze": "Most 😴 slow burn taps on one song",
    "rx-hype": "Sent the most reactions tonight", "rx-critic": "Sent the most playful roasts tonight",
    "s-mvp": "Most songs of the season", "s-loyal": "Sang on the most nights", "s-mic": "Most minutes on the mic",
    "s-badges": "Most badges earned", "s-range": "Songs from the most decades", "s-duet": "Most duets and group songs",
    "s-onesong": "Same song the most times", "s-crate": "Most pre-1980 songs (3+ songs)", "s-trend": "Most songs others sang later",
  };
  const how = (id) => HOW[id] || "";
  // The card's own "what" line, unless it just repeats the explanation in other words (keeps cards short).
  const SAYS_SAME = new Set(["mvp", "s-crowd", "s-hype", "rx-hype", "rx-critic", "s-mvp", "s-loyal", "s-mic", "s-badges", "s-range", "s-duet", "s-crate", "s-trend"]);
  const whatOf = (a) => (SAYS_SAME.has(a.id) || a.what === how(a.id) ? "" : a.what || "");

  function tallyFor(rows) {
    const singers = new Set(rows.map((p) => key(p.singer)).filter(Boolean)).size;
    const secs = rows.reduce((s, p) => s + (p.length_s || 0), 0);
    const hours = new Map(); rows.forEach((p) => { const h = localHour(p.played_at); hours.set(h, (hours.get(h) || 0) + 1); });
    const ph = [...hours.entries()].sort((a, b) => b[1] - a[1])[0];
    const fmtH = (h) => (h % 12 || 12) + (h < 12 ? "am" : "pm");
    return { songs: rows.length, singers, minutes: Math.round(secs / 60), peak: ph ? fmtH(ph[0]) : "—" };
  }

  global.OkeAwards = { HOW, how, whatOf, venueHM, ICON, icon, groupSize, personTotals, awardsFor, setHost, isHost, tallyFor, songLine, REACTIONS, HYPE, ROAST, reactionIndex, reactionAwards, sumOf, crowdScore, crowdOf, CROWD_MIN_DB };
})(typeof window !== "undefined" ? window : globalThis);
