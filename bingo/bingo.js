/* Karaoke Bingo: squares, cards and scoring.
 * Input rows: {night, played_at (UTC epoch s), singer, artist, title, release_year, length_s}
 * Usage: KaraokeBingo.mount(element, { getRows: async () => rows, onStatus: (msg, bad) => {} })
 * No dependencies; works on any static site or Worker-served page.
 */
(function (global) {
  const key = (s) => (s || "").trim().toLowerCase();
  const songs = (r) => r.filter((p) => p.title);
  const hit = (p, extra) => ({ who: (p.singer || "Someone").trim(), what: p.title ? "“" + p.title + "”" + (p.artist ? " · " + p.artist : "") : "a song", extra });
  const isGroup = (s) => /^table\s*\d+/i.test((s || "").trim()) || /(,|&|\/|\band\b|\bn\b|\+)/i.test(s || "");
  const localHour = (ts) => new Date(ts * 1000).getHours();

  // Each square: id, text (what to watch for), test(rowsTonight, ctx) -> hit or falsy
  // nth(pred, n): the song that made pred true for the nth time tonight
  const nth = (pred, n, label) => (r, ctx) => { let c = 0; for (const p of r) { if (pred(p, ctx) && ++c === n) return hit(p, n > 1 ? label || "#" + n : label); } };
  const yr = (a, b) => (p) => p.title && p.release_year >= a && p.release_year < b;
  const art = (re) => (p) => p.title && re.test(p.artist || "");
  const ttl = (re) => (p) => p.title && re.test(p.title || "");
  const SQUARES = [
    { id: "60s", text: "Two songs from the '60s", test: nth(yr(1960, 1970), 2) },
    { id: "70s", text: "Three '70s classics", test: nth(yr(1970, 1980), 3) },
    { id: "80s", text: "Five '80s bangers", test: nth(yr(1980, 1990), 5) },
    { id: "90s", text: "Ten '90s anthems", test: nth(yr(1990, 2000), 10) },
    { id: "00s", text: "Six 2000s throwbacks", test: nth(yr(2000, 2010), 6) },
    { id: "10s", text: "Three songs from the 2010s", test: nth(yr(2010, 2020), 3) },
    { id: "new", text: "Two songs from 2024 or later", test: nth((p) => p.title && p.release_year >= 2024, 2) },
    { id: "old", text: "A song older than 1965", test: nth(yr(1900, 1965), 1) },
    { id: "long", text: "A song over 6 minutes", test: nth((p) => p.length_s > 360, 1) },
    { id: "short", text: "A song under 2 minutes", test: nth((p) => p.length_s && p.length_s < 120, 1) },
    { id: "duet", text: "Five duets or groups", test: nth((p) => isGroup(p.singer), 5) },
    { id: "trio", text: "Three or more people on one mic", test: nth((p) => /^table\s*\d+/i.test((p.singer || "").trim()) || (p.singer || "").split(/\s*(?:,|&|\/|\band\b|\bn\b|\+)\s*/i).filter(Boolean).length >= 3, 1) },
    { id: "twice", text: "Same song sung twice tonight", test: (r) => { const seen = new Set(); for (const p of songs(r)) { const k = key(p.title); if (seen.has(k)) return hit(p, "again"); seen.add(k); } } },
    { id: "hat", text: "Someone sings 3 songs", test: (r) => { const c = new Map(); for (const p of r) { const k = key(p.singer); if (!k) continue; c.set(k, (c.get(k) || 0) + 1); if (c.get(k) === 3) return hit(p, "3rd song"); } } },
    { id: "b2b", text: "Same artist back to back", test: (r) => { const s = songs(r); for (let i = 1; i < s.length; i++) if (s[i].artist && key(s[i].artist) === key(s[i - 1].artist)) return hit(s[i], "back to back"); } },
    { id: "oasis", text: "Somebody sings Oasis", test: nth(art(/\boasis\b/i), 1) },
    { id: "mambo", text: "Mambo No. 5", test: nth(ttl(/mambo no\.? ?5/i), 1) },
    { id: "eclipse", text: "Total Eclipse of the Heart", test: nth(ttl(/total eclipse of the heart/i), 1) },
    { id: "screen", text: "Two songs from movies or musicals", test: nth(art(/\b(film|musical|movie)\b/i), 2) },
    { id: "number", text: "Two song titles with a number", test: nth(ttl(/\d/), 2) },
    { id: "love", text: "“Love” in two titles", test: nth(ttl(/\blove/i), 2) },
    { id: "night", text: "Night, moon or sun in a title", test: nth(ttl(/\b(night|moon|sun)\b/i), 1) },
    { id: "queen", text: "Queen, Bon Jovi or Def Leppard", test: nth(art(/^queen$|bon jovi|def leppard/i), 1) },
    { id: "punk", text: "Two punk songs (Misfits, Green Day, Clash…)", test: nth(art(/misfits|green day|the clash|nofx|ramones|blink|sex pistols|^l7$|bad religion|dead kennedys/i), 2) },
    { id: "diva", text: "Gaga, Britney or Beyoncé", test: nth(art(/lady gaga|britney|beyonc/i), 1) },
    { id: "country", text: "Dolly, Shania, Garth or the Chicks", test: nth(art(/dolly parton|shania|garth brooks|the chicks|carrie underwood|alan jackson|brooks & dunn/i), 1) },
    { id: "emo", text: "Paramore, Killers or Panic!", test: nth(art(/paramore|the killers|panic! at the disco|fall out boy|my chemical/i), 1) },
    { id: "bartender", text: "The bartender takes the mic", test: nth((p) => /bartender/i.test(p.singer || "") && !/not the bartender/i.test(p.singer || ""), 1) },
    { id: "regular", text: "A regular returns (3+ past nights)", test: nth((p, ctx) => (ctx.pastNights.get(key(p.singer)) || 0) >= 3, 1) },
    { id: "nick", text: "A singer in costume or with a stage name", test: nth((p) => /\(|\d|^(dj|mc|lil|big)\b|hotty|vega|hag|wallace|joasis|bride|groom/i.test(p.singer || ""), 1) },
    { id: "late", text: "Still singing after 1:45am", test: nth((p) => { const d = new Date(p.played_at * 1000), h = d.getHours(); return (h === 1 && d.getMinutes() >= 45) || (h >= 2 && h < 6); }, 1) },
    { id: "s40", text: "40 songs sung tonight", test: (r) => r.length >= 40 && hit(r[39], "song #40") },
    { id: "s60", text: "60 songs sung tonight", test: (r) => r.length >= 60 && hit(r[59], "song #60") },
  ];

  // Seeded shuffle so a card stays the same on reload
  function rng(seed) { let s = seed >>> 0 || 1; return () => ((s = (s * 1664525 + 1013904223) >>> 0) / 4294967296); }
  function makeCard(seed) {
    const r = rng(seed), pool = SQUARES.slice();
    for (let i = pool.length - 1; i > 0; i--) { const j = Math.floor(r() * (i + 1)); [pool[i], pool[j]] = [pool[j], pool[i]]; }
    const pick = pool.slice(0, 24).map((s) => s.id);
    pick.splice(12, 0, "free");
    return pick;
  }

  // 6am-6am "night" in the viewer's local time, as YYYY-MM-DD
  function tonight(now) { const d = new Date((now || Date.now()) - 6 * 3600 * 1000); return d.getFullYear() + "-" + String(d.getMonth() + 1).padStart(2, "0") + "-" + String(d.getDate()).padStart(2, "0"); }

  function evaluate(card, allRows, night) {
    const rows = allRows.filter((p) => p.night === night).sort((a, b) => a.played_at - b.played_at);
    const pastNights = new Map(), seen = new Map();
    allRows.forEach((p) => { if (p.night >= night) return; const k = key(p.singer); if (!k) return; const s = seen.get(k) || new Set(); s.add(p.night); seen.set(k, s); });
    seen.forEach((s, k) => pastNights.set(k, s.size));
    const ctx = { pastNights };
    const marks = card.map((id) => (id === "free" ? { free: true } : (SQUARES.find((s) => s.id === id).test(rows, ctx) || null)));
    const lines = [];
    for (let i = 0; i < 5; i++) { lines.push([0, 1, 2, 3, 4].map((j) => i * 5 + j)); lines.push([0, 1, 2, 3, 4].map((j) => j * 5 + i)); }
    lines.push([0, 6, 12, 18, 24], [4, 8, 12, 16, 20]);
    const won = lines.filter((l) => l.every((i) => marks[i]));
    return { rows, marks, won, count: marks.filter(Boolean).length - 1 };
  }

  function mount(root, opts) {
    const store = { get(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }, set(k, v) { try { localStorage.setItem(k, v); } catch (e) {} } };
    let allRows = [], night = null, card = null, lastWon = 0;
    const el = (t, c, x) => { const e = document.createElement(t); if (c) e.className = c; if (x != null) e.textContent = x; return e; };

    function ensureCard() {
      const k = "kb-card-" + night; let seed = Number(store.get(k));
      if (!seed) { seed = Math.floor(Math.random() * 4294967295) + 1; store.set(k, String(seed)); }
      card = makeCard(seed);
    }
    function newCard() { store.set("kb-card-" + night, String(Math.floor(Math.random() * 4294967295) + 1)); lastWon = 0; ensureCard(); draw(); }

    function draw() {
      const res = evaluate(card, allRows, night);
      root.replaceChildren();
      const head = el("div", "kb-head");
      const live = night === tonight();
      head.append(el("div", "kb-night", live ? "Tonight" : "Replay: " + new Date(night + "T12:00:00").toLocaleDateString("en-US", { weekday: "short", month: "short", day: "numeric" })),
        el("div", "kb-count", res.count + " of 24 · " + res.rows.length + " songs so far"));
      root.append(head);
      const winSet = new Set(res.won.flat());
      const grid = el("div", "kb-grid"); grid.setAttribute("role", "grid");
      ["B", "I", "N", "G", "O"].forEach((l) => grid.append(el("div", "kb-letter", l)));
      card.forEach((id, i) => {
        const m = res.marks[i];
        const sq = el("button", "kb-sq" + (m ? " on" : "") + (winSet.has(i) ? " win" : "") + (id === "free" ? " free" : ""));
        sq.type = "button";
        if (id === "free") { sq.append(el("span", "kb-t", "FREE"), el("span", "kb-w", "on the house")); }
        else { const s = SQUARES.find((x) => x.id === id); sq.append(el("span", "kb-t", s.text)); if (m) sq.append(el("span", "kb-w", m.who)); }
        sq.setAttribute("aria-label", (id === "free" ? "Free square" : SQUARES.find((x) => x.id === id).text) + (m && !m.free ? ", done by " + m.who + " with " + m.what : m ? "" : ", not yet"));
        sq.addEventListener("click", () => detail(id, m));
        grid.append(sq);
      });
      root.append(grid);
      const info = el("div", "kb-info"); info.id = "kb-info";
      info.textContent = res.won.length ? "BINGO! " + res.won.length + " line" + (res.won.length > 1 ? "s" : "") + ". Show this screen to the host." : "Squares fill in by themselves as songs get sung. Tap one to see who did it.";
      if (res.won.length) info.classList.add("bingo");
      root.append(info);
      const nb = el("button", "kb-new", "Get a new card"); nb.type = "button"; nb.addEventListener("click", newCard); root.append(nb);
      if (res.won.length > lastWon && lastWon !== null) { root.classList.remove("kb-pop"); void root.offsetWidth; root.classList.add("kb-pop"); }
      lastWon = res.won.length;
    }
    function detail(id, m) {
      const info = root.querySelector("#kb-info"); if (!info) return;
      if (id === "free") info.textContent = "The free square. Everybody gets one.";
      else if (m) info.textContent = m.who + " got it with " + m.what + (m.extra ? " (" + m.extra + ")" : "") + ".";
      else info.textContent = "Still waiting on: " + SQUARES.find((x) => x.id === id).text + ".";
    }
    async function refresh() {
      try {
        const rows = await opts.getRows();
        allRows = rows.map((p) => ({ ...p, played_at: Number(p.played_at), length_s: p.length_s ? Number(p.length_s) : null, release_year: p.release_year ? Number(p.release_year) : null }));
        const nights = [...new Set(allRows.map((p) => p.night).filter(Boolean))].sort();
        const t = tonight();
        const next = nights.includes(t) ? t : (opts.allowReplay === false ? t : nights[nights.length - 1] || t);
        if (next !== night) { night = next; lastWon = null; ensureCard(); }
        draw();
        opts.onStatus && opts.onStatus(null);
      } catch (e) { opts.onStatus && opts.onStatus(e && e.message ? e.message : String(e), true); }
    }
    return { refresh, setRows(rows) { opts.getRows = async () => rows; return refresh(); } };
  }

  global.KaraokeBingo = { SQUARES, makeCard, evaluate, tonight, mount };
})(typeof window !== "undefined" ? window : globalThis);
