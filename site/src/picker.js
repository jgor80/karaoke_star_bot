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
    const again = el("button", "see-all", "🎲 Shuffle"); again.type = "button";
    const body = el("div", "pk-body");
    box.append(body);
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

    // A cover card: the cover with a ＋ in the corner, then title, artist and why it's suggested.
    function card(s, why) {
      const li = el("li", "card-s");
      const have = readList().some((x) => tkey(x.t) === tkey(s.title) && akey(x.a) === akey(s.artist));
      const add = el("button", "add top-add" + (have ? " on" : ""), have ? "✓" : "＋"); add.type = "button";
      add.disabled = have; add.setAttribute("aria-label", have ? "“" + s.title + "” is on my list" : "Add “" + s.title + "” to my list");
      add.addEventListener("click", () => {
        const list = readList();
        list.push({ id: s.id || null, t: s.title, a: s.artist || "", y: s.year || null, duo: !!s.duo, at: Date.now(), done: 0 });
        try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {}
        add.textContent = "✓"; add.classList.add("on"); add.disabled = true;
        if (opts.onAdded) opts.onAdded();
      });
      const fig = el("div", "cs-fig"); fig.append(window.OkeArt ? OkeArt.el(s, { big: true }) : el("span", "art"), add);
      li.append(fig, el("span", "cs-t", s.title), el("span", "cs-s", s.artist || ""));
      if (why) li.append(el("span", "cs-m", why));
      return li;
    }
    function group(title, items, extra) {
      if (!items.length) return;
      const g = el("div", "sec pk-group"); const h = el("h2"); h.append(el("span", null, title)); if (extra) h.append(extra); g.append(h);
      const ol = el("ol", "shelf"); items.forEach(([s, why]) => ol.append(card(s, why))); g.append(ol); body.append(g);
    }

    function render() {
      const plays = opts.getPlays() || [];
      body.replaceChildren();
      if (!plays.length) return;
      const tonight = plays[plays.length - 1].night;
      const stats = songStats(plays, opts.getReax(), opts.getCrowd());
      const me = opts.getMe ? opts.getMe() : null;
      const mineK = new Set(me ? me.rows.map((p) => tkey(p.title) + "|" + akey(p.artist)) : []);
      const fresh = stats.filter((e) => e.last !== tonight && !mineK.has(e.k)); // not sung tonight, not one of yours

      // Crowd favorites: pick 3 from the top 12, so Shuffle gives new ideas.
      const top = fresh.slice().sort((a, b) => b.rank - a.rank).slice(0, 12);
      const why = (e) => e.avg != null && e.avg >= 6 ? "👏 " + e.avg.toFixed(1) + "/10" : e.hypePer >= 3 ? "🔥 big reactions" : "🎤 " + e.singers.size + " singer" + (e.singers.size === 1 ? "" : "s");
      group("Crowd favorites here", shuffle(top.slice()).slice(0, 8).map((e) => [e, why(e)]), again);

      if (me && window.KaraokeFun) {
        const bands = KaraokeFun.favoriteBands(me.rows, 3).map((b) => akey(b.name));
        const yours = fresh.filter((e) => bands.includes(akey(e.artist))).sort((a, b) => b.rank - a.rank).slice(0, 6).map((e) => [e, "💜 you love them"]);
        const best = stats.filter((e) => mineK.has(e.k) && e.last !== tonight).sort((a, b) => b.rank - a.rank)[0];
        if (best) yours.unshift([best, "🔁 your encore"]);
        group("For " + me.name, yours);
        const fav = KaraokeFun.favoriteBands(me.rows, 1)[0];
        loadCatalogIdeas(fav ? fav.name : "");
      } else loadCatalogIdeas("");
      const fromList = shuffle(catalogIdeas.slice()).slice(0, 8).map((s) => [s, "✨ never sung here"]);
      group(me ? "New from bands you like" : "Nobody’s sung these here yet", fromList);
    }
    again.addEventListener("click", () => { catalogFor = ""; render(); });
    // The page refreshes every 10 seconds during karaoke: only redraw (and reshuffle) when something changed.
    let lastKey = "";
    return { refresh() { const me = opts.getMe ? opts.getMe() : null, p = opts.getPlays() || [];
      const k = p.length + "|" + (me ? me.name : "") + "|" + (p.length ? p[p.length - 1].uuid : ""); if (k === lastKey) return; lastKey = k; render(); } };
  }
  global.OkePicker = { mount, songStats };
})(window);
