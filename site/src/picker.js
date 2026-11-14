// "What should I sing?" on the Songbook tab: a few song ideas with a reason for each, worked out on the phone.
//   - Crowd favorites: songs that got the loudest applause and the most hype reactions here (not sung tonight)
//   - For you (with "That's me" set): songs by your favorite bands you haven't sung, and your best encore
//   - Nobody's sung these: popular songs from the song list that have never been sung here
// Tap ＋ to put one on "My list" (songs.js keeps that list on the phone).
//
// OkePicker.mount({ box, getPlays, getReax, getCrowd, getMe, onAdded }) -> { refresh() }
//   getReax(): Map(play uuid -> {reaction: count}); getCrowd(): [{play, db}] applause in dB over the room
//   getMe(): {name, rows} for the "That's me" person, or null
(function (global) {
  const STORE = "oke-my-songs"; // same as songs.js
  const HYPE = ["fire", "micdrop", "encore", "chills", "dance", "keychange"];
  const tkey = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").normalize("NFD").replace(/[^a-z0-9]/g, "");
  const akey = (s) => String(s || "").toLowerCase().replace(/\bthe\b/g, "").replace(/[^a-z0-9]/g, "");
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const shuffle = (a) => { for (let i = a.length - 1; i > 0; i--) { const j = Math.floor(Math.random() * (i + 1)); [a[i], a[j]] = [a[j], a[i]]; } return a; };
  const readList = () => { try { const v = JSON.parse(localStorage.getItem(STORE) || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } };

  // One entry per song sung here: how often, the applause (0-10) and hype per time it was sung.
  function songStats(plays, reax, crowd) {
    const score = new Map((crowd || []).map((c) => [c.play, Math.max(0, Math.min(10, Number(c.db) / 2.5))]));
    const by = new Map();
    plays.forEach((p) => {
      if (!p.title) return;
      const k = tkey(p.title) + "|" + akey(p.artist);
      const e = by.get(k) || { k, title: p.title, artist: p.artist || "", id: p.song_id || null, year: p.release_year || null, n: 0, nights: new Set(), last: "", applause: [], hype: 0, singers: new Set() };
      e.n++; e.nights.add(p.night); if (p.night > e.last) e.last = p.night; e.singers.add(String(p.singer || "").toLowerCase());
      if (score.has(p.uuid)) e.applause.push(score.get(p.uuid));
      const r = (reax && reax.get(p.uuid)) || {}; e.hype += HYPE.reduce((a, x) => a + (r[x] || 0), 0);
      by.set(k, e);
    });
    by.forEach((e) => {
      e.avg = e.applause.length ? e.applause.reduce((a, b) => a + b, 0) / e.applause.length : null;
      e.hypePer = e.hype / e.n;
      // Loud songs first; songs without a reading lean on hype and how many different people picked them.
      e.rank = (e.avg != null ? e.avg : 4) + Math.min(4, e.hypePer / 2) + Math.min(2, Math.log2(e.singers.size + 1));
    });
    return [...by.values()];
  }

  function mount(opts) {
    const box = opts.box;
    box.replaceChildren();
    const head = el("div", "pk-head");
    const h = el("h2", null, "🎲 What should I sing?");
    const again = el("button", "act ghost pk-again", "Shuffle"); again.type = "button";
    head.append(h, again);
    const body = el("div", "pk-body");
    box.append(head, body);
    let catalogIdeas = [], catalogFor = "";

    async function loadCatalogIdeas(artist) {
      // Popular songs from the song list (or by your favorite band) that nobody has sung here yet.
      const q = artist ? "q=" + encodeURIComponent(artist) + "&sort=pop" : "hits=1&sort=pop&page=" + Math.floor(Math.random() * 6);
      if (catalogFor === q) return;
      catalogFor = q;
      try {
        const r = await fetch("api/catalog?" + q); const d = await r.json();
        const sung = new Set((opts.getPlays() || []).map((p) => tkey(p.title)));
        catalogIdeas = (d.songs || []).filter((s) => !sung.has(tkey(s.title)));
        render();
      } catch (e) { catalogIdeas = []; }
    }

    function row(s, why) {
      const li = el("li");
      const have = readList().some((x) => tkey(x.t) === tkey(s.title) && akey(x.a) === akey(s.artist));
      const main = el("span", "main-t", "“" + s.title + "”");
      const sub = el("span", "sub-t", [s.artist, why].filter(Boolean).join(" · "));
      const add = el("button", "dr-vote" + (have ? " on" : ""), have ? "✓ On my list" : "＋ My list"); add.type = "button";
      add.disabled = have;
      add.addEventListener("click", () => {
        const list = readList();
        list.push({ id: s.id || null, t: s.title, a: s.artist || "", y: s.year || null, duo: !!s.duo, at: Date.now(), done: 0 });
        try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {}
        add.textContent = "✓ On my list"; add.classList.add("on"); add.disabled = true;
        if (opts.onAdded) opts.onAdded();
      });
      li.append(main, add, sub);
      if (window.OkeArt) OkeArt.row(li, s);
      return li;
    }
    function group(title, items) {
      if (!items.length) return;
      const g = el("div", "pk-group"); g.append(el("div", "me-kicker", title));
      const ol = el("ol", "list"); items.forEach(([s, why]) => ol.append(row(s, why))); g.append(ol); body.append(g);
    }

    function render() {
      const plays = opts.getPlays() || [];
      body.replaceChildren();
      if (!plays.length) { body.append(el("p", "muted small", "Ideas show up once a few songs have been sung here.")); return; }
      const tonight = plays[plays.length - 1].night;
      const stats = songStats(plays, opts.getReax(), opts.getCrowd());
      const me = opts.getMe ? opts.getMe() : null;
      const mineK = new Set(me ? me.rows.map((p) => tkey(p.title) + "|" + akey(p.artist)) : []);
      const fresh = stats.filter((e) => e.last !== tonight && !mineK.has(e.k)); // not sung tonight, not one of yours

      // Crowd favorites: pick 3 from the top 12, so Shuffle gives new ideas.
      const top = fresh.slice().sort((a, b) => b.rank - a.rank).slice(0, 12);
      const why = (e) => e.avg != null && e.avg >= 6 ? "👏 " + e.avg.toFixed(1) + "/10 applause here" : e.hypePer >= 3 ? "🔥 big reactions here" : "sung by " + e.singers.size + (e.singers.size === 1 ? " person" : " people") + " here";
      group("Crowd favorites here", shuffle(top.slice()).slice(0, 3).map((e) => [e, why(e)]));

      if (me && window.KaraokeFun) {
        const bands = KaraokeFun.favoriteBands(me.rows, 3).map((b) => akey(b.name));
        const yours = fresh.filter((e) => bands.includes(akey(e.artist))).sort((a, b) => b.rank - a.rank).slice(0, 2).map((e) => [e, "you love " + e.artist]);
        const best = stats.filter((e) => mineK.has(e.k) && e.last !== tonight).sort((a, b) => b.rank - a.rank)[0];
        if (best) yours.push([best, "your encore" + (best.avg != null ? " · 👏 " + best.avg.toFixed(1) + "/10" : "")]);
        group("For " + me.name, yours);
        const fav = KaraokeFun.favoriteBands(me.rows, 1)[0];
        loadCatalogIdeas(fav ? fav.name : "");
      } else loadCatalogIdeas("");
      const fromList = shuffle(catalogIdeas.slice()).slice(0, 3).map((s) => [s, "never sung here"]);
      group(me ? "New from bands you like" : "Popular songs nobody’s sung here yet", fromList);
      if (!me) body.append(el("p", "muted small", "Tip: find your name on the Singers tab and tap “That’s me” for ideas picked for you."));
    }
    again.addEventListener("click", () => { catalogFor = ""; render(); });
    // The page refreshes every 10 seconds during karaoke: only redraw (and reshuffle) when something changed.
    let lastKey = "";
    return { refresh() { const me = opts.getMe ? opts.getMe() : null, p = opts.getPlays() || [];
      const k = p.length + "|" + (me ? me.name : "") + "|" + (p.length ? p[p.length - 1].uuid : ""); if (k === lastKey) return; lastKey = k; render(); } };
  }
  global.OkePicker = { mount, songStats };
})(window);
