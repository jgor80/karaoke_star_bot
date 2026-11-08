/* Karaoke night awards ("The Mics"): pure functions over plays rows.
 * rows: {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s}, sorted by played_at.
 * KaraokeAwards.awardsFor(rowsOfOneNight) -> [{id, label, who, what, stat, headline?}]
 * KaraokeAwards.tallyFor(rowsOfOneNight)  -> {songs, singers, minutes, peak}
 * KaraokeAwards.records(allRows)          -> [{label, who, stat, what}]  (hall of fame)
 * KaraokeAwards.drawCard(canvas1080x1350, {night}, tally, awards); KaraokeAwards.captionFor({night}, tally, awards)
 */
(function (global) {
  // ---------- helpers ----------
  const key = (s) => (s || "").trim().toLowerCase();
  const clean = (s) => (s || "").trim().replace(/\s+/g, " ");
  const mmss = (s) => Math.floor(s / 60) + ":" + String(s % 60).padStart(2, "0");
  const nightLabel = (n, long) => {
    const d = new Date(n + "T12:00:00");
    return d.toLocaleDateString("en-US", long ? { weekday: "long", month: "long", day: "numeric" } : { weekday: "short", month: "short", day: "numeric" });
  };
  const localHour = (ts) => new Date(ts * 1000).getHours();
  function groupSize(name) {
    const n = key(name);
    if (/^table\s*\d+/.test(n)) return 4; // a whole table counts as a crowd
    const parts = n.split(/\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/).filter(Boolean);
    return parts.length;
  }
  function songLine(p) { return p.title ? "“" + p.title + "”" + (p.artist ? " · " + p.artist : "") : "a mystery song"; }

  // ---------- awards for one night ----------
  function awardsFor(rows) {
    const out = [];
    const songs = rows.filter((p) => p.title);
    const timed = songs.filter((p) => p.length_s);
    const dated = songs.filter((p) => p.release_year);

    // MVP: most songs, then most mic time
    const bySinger = new Map();
    rows.forEach((p) => { if (!key(p.singer)) return; const k = key(p.singer);
      const e = bySinger.get(k) || { name: clean(p.singer), n: 0, secs: 0 }; e.n++; e.secs += p.length_s || 0; bySinger.set(k, e); });
    const mvp = [...bySinger.values()].sort((a, b) => b.n - a.n || b.secs - a.secs)[0];
    if (mvp && mvp.n > 1) out.push({ id: "mvp", headline: true, label: "Mic Hog", who: mvp.name, what: "Most songs of the night", stat: mvp.n + " songs · " + mmss(mvp.secs) + " on the mic" });

    // Broken Record: same singer, same song, more than once
    const rep = new Map();
    songs.forEach((p) => { const k = key(p.singer) + "|" + key(p.title); const e = rep.get(k) || { p, n: 0 }; e.n++; rep.set(k, e); });
    const br = [...rep.values()].filter((e) => e.n > 1 && key(e.p.singer)).sort((a, b) => b.n - a.n)[0];
    if (br) out.push({ id: "broken", headline: true, label: "Broken Record", who: clean(br.p.singer), what: songLine(br.p), stat: br.n + " times in one night" });

    // Déjà Vu: same song title from different singers or versions
    const byTitle = new Map();
    songs.forEach((p) => { const k = key(p.title); const e = byTitle.get(k) || []; e.push(p); byTitle.set(k, e); });
    const dv = [...byTitle.values()].filter((l) => new Set(l.map((p) => key(p.singer) + "|" + key(p.artist))).size > 1).sort((a, b) => b.length - a.length)[0];
    if (dv) { const names = [...new Set(dv.map((p) => clean(p.singer) || "someone"))];
      out.push({ id: "dejavu", label: "Déjà Vu", who: names.join(" + "), what: "“" + dv[0].title + "”, more than once", stat: dv.length + " plays" + (new Set(dv.map((p) => key(p.artist))).size > 1 ? ", different versions" : "") }); }

    // Marathon & Speed Run
    if (timed.length) {
      const long = timed.reduce((a, b) => (b.length_s > a.length_s ? b : a));
      const short = timed.reduce((a, b) => (b.length_s < a.length_s ? b : a));
      out.push({ id: "marathon", headline: !br, label: "Marathon", who: clean(long.singer) || "Someone", what: songLine(long), stat: mmss(long.length_s) + " long" });
      out.push({ id: "speed", label: "Speed Run", who: clean(short.singer) || "Someone", what: songLine(short), stat: "over in " + mmss(short.length_s) });
    }
    // Time Traveler & Fresh Drop
    if (dated.length) {
      const old = dated.reduce((a, b) => (b.release_year < a.release_year ? b : a));
      const fresh = dated.reduce((a, b) => (b.release_year > a.release_year ? b : a));
      out.push({ id: "time", headline: true, label: "Time Traveler", who: clean(old.singer) || "Someone", what: songLine(old), stat: "from " + old.release_year });
      out.push({ id: "fresh", label: "Fresh Drop", who: clean(fresh.singer) || "Someone", what: songLine(fresh), stat: "from " + fresh.release_year });
    }
    // Squad Goals: biggest group on the mic
    const sq = rows.filter((p) => key(p.singer)).map((p) => ({ p, n: groupSize(p.singer) })).sort((a, b) => b.n - a.n)[0];
    if (sq && sq.n > 1) out.push({ id: "squad", label: "Squad Goals", who: clean(sq.p.singer), what: songLine(sq.p), stat: /^table/i.test(sq.p.singer.trim()) ? "a whole table" : sq.n + " voices" });
    // Opening Act & Last Call
    const first = rows[0], last = rows[rows.length - 1];
    if (first) out.push({ id: "open", label: "Opening Act", who: clean(first.singer) || "Someone", what: songLine(first), stat: "first brave soul" });
    if (last && last !== first) out.push({ id: "last", label: "Last Call", who: clean(last.singer) || "Someone", what: songLine(last), stat: "closed the night" });
    // Artist of the night
    const art = new Map();
    songs.forEach((p) => { if (!p.artist) return; const k = key(p.artist); const e = art.get(k) || { name: p.artist, n: 0, who: new Set() }; e.n++; e.who.add(clean(p.singer)); art.set(k, e); });
    const top = [...art.values()].sort((a, b) => b.n - a.n)[0];
    if (top && top.n > 1) out.push({ id: "artist", label: "Artist of the Night", who: top.name, what: "Sung by " + [...top.who].filter(Boolean).join(", "), stat: top.n + " songs" });
    // Decade of the night
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
    const fmtH = (h) => { const x = h % 12 || 12; return x + (h < 12 ? "am" : "pm"); };
    return { songs: rows.length, singers, minutes: Math.round(secs / 60), peak: ph ? fmtH(ph[0]) + "–" + fmtH((ph[0] + 1) % 24) : "—" };
  }

  function records(plays) {
    const byN = new Map(); plays.forEach((p) => { if (p.night) (byN.get(p.night) || byN.set(p.night, []).get(p.night)).push(p); });
    const nights = [...byN.entries()].map(([night, rows]) => ({ night, rows }));
    const rec = [];
    const songs = plays.filter((p) => p.title);
    const timed = songs.filter((p) => p.length_s), dated = songs.filter((p) => p.release_year);
    if (timed.length) { const l = timed.reduce((a, b) => (b.length_s > a.length_s ? b : a));
      rec.push(["Longest song ever", clean(l.singer), mmss(l.length_s), songLine(l) + ", " + nightLabel(l.night)]); }
    if (dated.length) { const o = dated.reduce((a, b) => (b.release_year < a.release_year ? b : a));
      rec.push(["Oldest song ever", clean(o.singer), String(o.release_year), songLine(o) + ", " + nightLabel(o.night)]); }
    // most nights attended
    const att = new Map(); plays.forEach((p) => { const k = key(p.singer); if (!k) return; const e = att.get(k) || { name: clean(p.singer), nights: new Set(), n: 0 }; e.nights.add(p.night); e.n++; att.set(k, e); });
    const reg = [...att.values()].sort((a, b) => b.nights.size - a.nights.size || b.n - a.n).slice(0, 3);
    if (reg.length) rec.push(["Most loyal regulars", reg.map((r) => r.name).join(", "), reg[0].nights.size + " nights", reg.map((r) => r.name + ": " + r.nights.size + " nights, " + r.n + " songs").join(" · ")]);
    // signature song: same singer+song across the most nights
    const sig = new Map(); songs.forEach((p) => { const k = key(p.singer) + "|" + key(p.title); if (!key(p.singer)) return; const e = sig.get(k) || { p, n: 0 }; e.n++; sig.set(k, e); });
    const s = [...sig.values()].sort((a, b) => b.n - a.n)[0];
    if (s && s.n > 1) rec.push(["Signature song", clean(s.p.singer), s.n + " times", songLine(s.p)]);
    // biggest night
    const big = nights.slice().sort((a, b) => b.rows.length - a.rows.length)[0];
    if (big) rec.push(["Biggest night", nightLabel(big.night, true), big.rows.length + " songs", tallyFor(big.rows).singers + " different singers"]);
    // most-sung song overall
    const sc = new Map(); songs.forEach((p) => { const k = key(p.title) + "|" + key(p.artist); const e = sc.get(k) || { p, n: 0 }; e.n++; sc.set(k, e); });
    const tops = [...sc.values()].sort((a, b) => b.n - a.n)[0];
    if (tops && tops.n > 1) rec.push(["Most-sung song", "“" + tops.p.title + "”", tops.n + " plays", tops.p.artist || ""]);
    return rec.map(([label, who, stat, what]) => ({ label, who, stat, what }));
  }

  // ---------- recap card (canvas) ----------
  function wrapText(ctx, text, x, y, maxW, lh, maxLines) {
    const words = text.split(" "); let line = "", lines = [];
    words.forEach((w) => { const t = line ? line + " " + w : w; if (ctx.measureText(t).width > maxW && line) { lines.push(line); line = w; } else line = t; });
    if (line) lines.push(line);
    if (lines.length > maxLines) { lines = lines.slice(0, maxLines); lines[maxLines - 1] = lines[maxLines - 1].replace(/\s*\S*$/, "") + "…"; }
    lines.forEach((l, i) => ctx.fillText(l, x, y + i * lh)); return lines.length * lh;
  }
  function drawCard(c, n, t, aw) {
    const ctx = c.getContext("2d"), W = 1080, H = 1350;
    const g = ctx.createLinearGradient(0, 0, 0, H); g.addColorStop(0, "#2a0f33"); g.addColorStop(1, "#120818");
    ctx.fillStyle = g; ctx.fillRect(0, 0, W, H);
    // spotlight
    const r = ctx.createRadialGradient(W / 2, -80, 40, W / 2, -80, 900); r.addColorStop(0, "rgba(245,184,74,.28)"); r.addColorStop(1, "rgba(245,184,74,0)");
    ctx.fillStyle = r; ctx.fillRect(0, 0, W, H);
    // marquee bulbs
    ctx.fillStyle = "#f5b84a"; for (let x = 40; x < W; x += 50) { ctx.beginPath(); ctx.arc(x, 34, 7, 0, 7); ctx.fill(); ctx.beginPath(); ctx.arc(x, H - 34, 7, 0, 7); ctx.fill(); }
    const P = 80;
    ctx.fillStyle = "#ff5c9d"; ctx.font = "400 104px Bungee, Impact, sans-serif"; ctx.fillText("THE MICS", P, 190);
    ctx.fillStyle = "#f6ecf8"; ctx.font = "600 44px Figtree, system-ui, sans-serif"; ctx.fillText(nightLabel(n.night, true), P, 260);
    ctx.fillStyle = "#b6a3bd"; ctx.font = "500 32px 'DM Mono', monospace";
    ctx.fillText(t.songs + " songs  ·  " + t.singers + " singers  ·  " + t.minutes + " min", P, 315);
    ctx.fillStyle = "rgba(255,255,255,.14)"; ctx.fillRect(P, 350, W - 2 * P, 2);
    const order = ["mvp", "broken", "marathon", "time", "squad", "dejavu", "fresh", "last"];
    const pick = order.map((id) => aw.find((a) => a.id === id)).filter(Boolean).slice(0, 5);
    let y = 420;
    pick.forEach((a) => {
      ctx.fillStyle = "#f5b84a"; ctx.font = "500 26px 'DM Mono', monospace"; ctx.fillText(a.label.toUpperCase(), P, y);
      ctx.fillStyle = "#ffffff"; ctx.font = "700 48px Figtree, system-ui, sans-serif"; y += 56 + wrapText(ctx, a.who, P, y + 56, W - 2 * P, 54, 1) - 54;
      ctx.fillStyle = "#d9c8de"; ctx.font = "400 30px Figtree, system-ui, sans-serif"; y += 44; wrapText(ctx, a.what + "  —  " + a.stat, P, y, W - 2 * P, 38, 1);
      y += 76;
    });
    ctx.fillStyle = "#ff5c9d"; ctx.font = "400 34px Bungee, Impact, sans-serif"; ctx.fillText("SEE YOU AT THE MIC", P, H - 90);
  }

  function captionFor(n, t, aw) {
    const get = (id) => aw.find((a) => a.id === id);
    const lines = ["🎤 The Mics, " + nightLabel(n.night, true), t.songs + " songs from " + t.singers + " singers. Here are your winners:"];
    ["mvp", "broken", "marathon", "time", "squad", "last"].forEach((id) => { const a = get(id); if (a) lines.push("• " + a.label + ": " + a.who + " (" + a.what + ")"); });
    lines.push("", "#karaoke #karaokenight");
    return lines.join("\n");
  }

  global.KaraokeAwards = { awardsFor, tallyFor, records, drawCard, captionFor, nightLabel };
})(typeof window !== "undefined" ? window : globalThis);
