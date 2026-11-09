/* Karaoke fun layer: singer badges, nightly dares and the "watch" song.
 * Pure functions over plays rows {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s},
 * sorted by played_at. No dependencies. Exposed as window.KaraokeFun.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const SPLIT = /\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/i;
  const isTable = (s) => /^table\s*\d+/i.test((s || "").trim());
  const isGroup = (s) => isTable(s) || SPLIT.test((s || "").trim());
  const decade = (y) => Math.floor(y / 10) * 10;
  const art = (re) => (p) => p.title && re.test(p.artist || "");
  const lateNight = (p) => { const d = new Date(p.played_at * 1000), h = d.getHours(); return (h === 1 && d.getMinutes() >= 30) || (h >= 2 && h < 6); };
  const PUNK = /misfits|green day|the clash|nofx|ramones|blink|sex pistols|^l7$|bad religion|dead kennedys|alkaline trio|front bottoms|ajj/i;
  const BRIT = /^oasis$|^pulp$|^blur$|^the verve$|^suede$|^radiohead$|^the smiths$/i;
  const COLOR = /\b(red|blue|black|white|green|pink|gold|golden|purple|yellow|silver|orange)\b/i;

  // ---------- badges ----------
  // Each badge looks at one person's rows (solo and group songs) plus the whole history.
  // test(rows, i, ctx) is called after each of that person's songs; the first true call earns the badge at rows[i].
  const BADGES = [
    { id: "debut", name: "Debut", desc: "Sang a first song here", test: () => true },
    { id: "regular", name: "Regular", desc: "Sang on 3 different nights", test: (r, i) => new Set(r.slice(0, i + 1).map((p) => p.night)).size >= 3 },
    { id: "lifer", name: "Lifer", desc: "Sang on 6 different nights", test: (r, i) => new Set(r.slice(0, i + 1).map((p) => p.night)).size >= 6 },
    { id: "hattrick", name: "Hat Trick", desc: "3 songs in one night", test: (r, i) => r.slice(0, i + 1).filter((p) => p.night === r[i].night).length >= 3 },
    { id: "hopper", name: "Decade Hopper", desc: "Songs from 4 different decades", test: (r, i) => new Set(r.slice(0, i + 1).filter((p) => p.release_year).map((p) => decade(p.release_year))).size >= 4 },
    { id: "timelord", name: "Time Lord", desc: "Songs from 6 different decades", test: (r, i) => new Set(r.slice(0, i + 1).filter((p) => p.release_year).map((p) => decade(p.release_year))).size >= 6 },
    { id: "oldie", name: "Golden Oldie", desc: "Sang a song from before 1970", test: (r, i) => r[i].release_year && r[i].release_year < 1970 },
    { id: "fresh", name: "Fresh Ears", desc: "Sang a song less than 2 years old", test: (r, i) => r[i].release_year && Number(r[i].night.slice(0, 4)) - r[i].release_year <= 1 },
    { id: "marathon", name: "Marathoner", desc: "Finished a song over 6 minutes", test: (r, i) => r[i].length_s > 360 },
    { id: "sprint", name: "Sprinter", desc: "Sang a song under 2 minutes", test: (r, i) => r[i].length_s && r[i].length_s < 120 },
    { id: "duet", name: "Duet Partner", desc: "Shared the mic with someone", test: (r, i) => isGroup(r[i].singer) },
    { id: "broken", name: "Broken Record", desc: "Same song twice in one night", test: (r, i) => r[i].title && r.slice(0, i).some((p) => p.night === r[i].night && key(p.title) === key(r[i].title)) },
    { id: "signature", name: "Signature Song", desc: "Same song on 2 different nights", test: (r, i) => r[i].title && r.slice(0, i).some((p) => p.night !== r[i].night && key(p.title) === key(r[i].title)) },
    { id: "loyal", name: "Superfan", desc: "Same artist 3 times", test: (r, i) => r[i].artist && r.slice(0, i + 1).filter((p) => key(p.artist) === key(r[i].artist)).length >= 3 },
    { id: "brit", name: "Britpop Lifer", desc: "2 Britpop songs (Oasis, Pulp, Blur…)", test: (r, i) => r.slice(0, i + 1).filter(art(BRIT)).length >= 2 },
    { id: "punk", name: "Punk Points", desc: "2 punk songs", test: (r, i) => r.slice(0, i + 1).filter(art(PUNK)).length >= 2 },
    { id: "owl", name: "Night Owl", desc: "Sang after 1:30am", test: (r, i) => lateNight(r[i]) },
    { id: "opener", name: "Opening Act", desc: "Sang the first song of a night", test: (r, i, ctx) => ctx.firstOf.get(r[i].night) === r[i] },
    { id: "closer", name: "Closer", desc: "Sang the last song of a night", test: (r, i, ctx) => ctx.lastOf.get(r[i].night) === r[i] && r[i].night !== ctx.liveNight },
    { id: "trend", name: "Trendsetter", desc: "Sang a song someone else picked up later", test: (r, i, ctx) => r[i].title && ctx.byTitle.get(key(r[i].title)).some((p) => p.played_at > r[i].played_at && key(p.singer) !== key(r[i].singer)) },
  ];

  // People: solo singer names, plus each part of a group name that is also a solo singer ("Val and bleacher jeff" -> val, bleacher jeff).
  function people(plays) {
    const solo = new Map();
    plays.forEach((p) => { const k = key(p.singer); if (k && !isGroup(p.singer)) { if (!solo.has(k)) solo.set(k, { key: k, name: clean(p.singer), rows: [] }); } });
    const add = (k, p) => { const e = solo.get(k); if (e && e.rows[e.rows.length - 1] !== p) e.rows.push(p); };
    plays.forEach((p) => {
      const k = key(p.singer); if (!k) return;
      if (!isGroup(p.singer)) { add(k, p); return; }
      if (!isTable(p.singer)) k.split(SPLIT).map((x) => x.trim()).filter(Boolean).forEach((part) => add(part, p));
    });
    return solo;
  }

  function context(plays, liveNight) {
    const firstOf = new Map(), lastOf = new Map(), byTitle = new Map();
    plays.forEach((p) => { if (!firstOf.has(p.night)) firstOf.set(p.night, p); lastOf.set(p.night, p);
      if (p.title) { const k = key(p.title); (byTitle.get(k) || byTitle.set(k, []).get(k)).push(p); } });
    return { firstOf, lastOf, byTitle, liveNight };
  }

  // -> Map(personKey -> {name, rows, badges: [{id, name, desc, at: row}]})
  function badgesAll(plays, liveNight) {
    const ctx = context(plays, liveNight);
    const ppl = people(plays);
    ppl.forEach((e) => {
      e.badges = [];
      BADGES.forEach((b) => { for (let i = 0; i < e.rows.length; i++) if (b.test(e.rows, i, ctx)) { e.badges.push({ id: b.id, name: b.name, desc: b.desc, at: e.rows[i] }); break; } });
    });
    return ppl;
  }

  // Badges first earned on `night` (Debut left out: everyone gets it)
  function unlockedOn(ppl, night) {
    const out = [];
    ppl.forEach((e) => e.badges.forEach((b) => { if (b.at.night === night && b.id !== "debut") out.push({ who: e.name, badge: b }); }));
    return out.sort((a, b) => b.badge.at.played_at - a.badge.at.played_at);
  }

  // ---------- dares ----------
  // Each night gets 3 dares picked from the pool by the night's date. First song that meets one claims it.
  const DARES = [
    { id: "oldie", text: "Sing a song from before 1970", test: (p) => p.release_year && p.release_year < 1970 },
    { id: "fresh", text: "Sing something from this year or last", test: (p) => p.release_year && Number(p.night.slice(0, 4)) - p.release_year <= 1 },
    { id: "duet", text: "Grab a partner for a duet", test: (p) => isGroup(p.singer) },
    { id: "newartist", text: "Sing an artist nobody has sung here before", test: (p, ctx) => p.artist && !ctx.pastArtists.has(key(p.artist)) },
    { id: "long", text: "Go the distance: a song over 6 minutes", test: (p) => p.length_s > 360 },
    { id: "screen", text: "Sing a song from a movie or musical", test: (p) => /\b(film|musical|movie)\b/i.test(p.artist || "") },
    { id: "return", text: "Bring back a song from a past night", test: (p, ctx) => p.title && ctx.pastTitles.has(key(p.title)) },
    { id: "color", text: "Sing a song with a color in the title", test: (p) => COLOR.test(p.title || "") },
    { id: "number", text: "Sing a song with a number in the title", test: (p) => /\d/.test(p.title || "") },
    { id: "short", text: "Speed round: a song under 2½ minutes", test: (p) => p.length_s && p.length_s < 150 },
    { id: "seventies", text: "Take us back to the '70s", test: (p) => p.release_year >= 1970 && p.release_year < 1980 },
    { id: "punk", text: "Start a mosh pit: sing a punk song", test: art(PUNK) },
    { id: "country", text: "Country night: Dolly, Shania, Garth, the Chicks…", test: art(/dolly parton|shania|garth brooks|the chicks|carrie underwood|alan jackson|brooks & dunn|zach bryan|midland/i) },
    { id: "firsttimer", text: "A first-timer takes the mic after 11pm", test: (p, ctx) => !ctx.pastSingers.has(key(p.singer)) && key(p.singer) && (new Date(p.played_at * 1000).getHours() >= 23 || new Date(p.played_at * 1000).getHours() < 6) },
    { id: "table", text: "Get your whole table up there", test: (p) => isTable(p.singer) || (p.singer || "").split(SPLIT).filter(Boolean).length >= 3 },
  ];
  function hash(s) { let h = 2166136261; for (const c of s) { h ^= c.charCodeAt(0); h = Math.imul(h, 16777619); } return h >>> 0; }
  function daresFor(night) {
    const pool = DARES.slice(); let h = hash("dares:" + night); const out = [];
    while (out.length < 3 && pool.length) { out.push(pool.splice(h % pool.length, 1)[0]); h = hash(String(h)); }
    return out;
  }
  // -> [{id, text, claimedBy: row|null}]
  function daresStatus(plays, night) {
    const past = plays.filter((p) => p.night < night), rows = plays.filter((p) => p.night === night);
    const ctx = { pastArtists: new Set(past.map((p) => key(p.artist)).filter(Boolean)), pastTitles: new Set(past.map((p) => key(p.title)).filter(Boolean)), pastSingers: new Set(past.map((p) => key(p.singer)).filter(Boolean)) };
    return daresFor(night).map((d) => ({ id: d.id, text: d.text, claimedBy: rows.find((p) => key(p.singer) && d.test(p, ctx)) || null }));
  }

  // ---------- the watch ----------
  // The song sung on the most different nights: "will it happen tonight?"
  function watchSong(plays, night) {
    const by = new Map();
    plays.forEach((p) => { if (!p.title) return; const k = key(p.title); const e = by.get(k) || { title: p.title, artist: p.artist, nights: new Set(), rows: [] }; e.nights.add(p.night); e.rows.push(p); by.set(k, e); });
    const w = [...by.values()].filter((e) => e.nights.size >= 2).sort((a, b) => b.nights.size - a.nights.size || b.rows.length - a.rows.length)[0];
    if (!w) return null;
    const allNights = new Set(plays.map((p) => p.night));
    const tonight = w.rows.filter((p) => p.night === night);
    const pastNights = [...w.nights].filter((n) => n !== night).length, totalPast = [...allNights].filter((n) => n !== night).length;
    return { title: w.title, artist: w.artist, pastNights, totalPast, tonight };
  }

  global.KaraokeFun = { BADGES, DARES, badgesAll, unlockedOn, daresStatus, daresFor, watchSong, people };
})(typeof window !== "undefined" ? window : globalThis);
