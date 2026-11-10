// Songbook tab: search the karaoke app's catalog (/api/catalog) and keep a list of songs you want to sing.
// The list is saved on this phone only (localStorage), so there are no accounts.
//
// OkeSongs.mount({ find, mine, count, getPlays, getMyRows, onPick })
//   find, mine: the "Find a song" and "My list" containers; count: element for the list size
//   getPlays(): every play (with song_id, title, artist), for "sung here" counts and the fallback search
//   getMyRows(): plays by the person this phone picked as "That's me", so songs they sing get ticked off
// Returns { refresh() } to call when new plays arrive.
(function (global) {
  const STORE = "oke-my-songs";
  const MAX_LIST = 200;
  let memory = []; // used when the phone blocks storage

  // The karaoke app's style and language names, most common first (from the catalog, 2026-11). "Duet" has its own toggle.
  const GENRES = ["Pop", "Rock", "Country", "Latin Music", "Soundtrack", "Love", "Soul", "Alternative", "Jazz", "Dance", "Folk",
    "R&B", "Rap", "Hip-Hop", "Electro", "Soft rock", "Hard Rock", "Musical", "Synthpop", "Metal", "Rock 'n Roll", "Christmas",
    "Blues", "Spiritual Music", "Gospel", "Traditional", "Teen pop", "World/Folk", "Funk", "Humor", "Kids", "Disco", "Reggae",
    "Punk/Grunge", "French pop", "Schlager", "Zouk/Creole/Soca/Calypso", "Ska", "Classical", "Moyen Orient"];
  // Genre pills shown up front, with an emoji each. The rest are under "More".
  const FEATURED = [["Pop", "🎤"], ["Rock", "🎸"], ["Country", "🤠"], ["Latin Music", "💃"], ["R&B", "🎷"], ["Hip-Hop", "🎧"],
    ["Rap", "🔥"], ["Soul", "💜"], ["Love", "💘"], ["Dance", "🪩"], ["Alternative", "🖤"], ["Disco", "🕺"], ["Soundtrack", "🎬"],
    ["Musical", "🎭"], ["Rock 'n Roll", "🕶️"], ["Metal", "🤘"], ["Punk/Grunge", "⚡"], ["Christmas", "🎄"], ["Kids", "🧸"]];
  const GENRE_LABEL = { "Love": "Love songs", "Latin Music": "Latin", "Moyen Orient": "Middle Eastern", "Humor": "Comedy", "Spiritual Music": "Spiritual" };
  const DECADES = [2020, 2010, 2000, 1990, 1980, 1970, 1960, 1950, 1900];
  const LANGS = ["English", "Spanish", "French", "Portuguese", "German", "Italian", "Dutch", "Korean", "Japanese"];
  const SORT_OPTS = [["pop", "Most popular", "most popular first"], ["new", "Newly added", "newest additions first"],
    ["recent", "Newest songs", "newest songs first"], ["old", "Oldest songs", "oldest songs first"]];

  const VOICES = [["m", "🙋‍♂️ Male voice"], ["f", "🙋‍♀️ Female voice"], ["mix", "👫 Guy + girl duets"]];
  const VOICE_WORDS = { m: "male singers", f: "female singers", mix: "guy + girl duets" };

  // A sideways-scrolling pill row with ‹ › buttons that show while there's more to see, so it's
  // obvious the row scrolls, and it works with a mouse too (wheel and drag).
  function scroller(row) {
    const wrap = el("div", "pill-scroll");
    const prev = el("button", "ps-btn ps-prev", "‹"), next = el("button", "ps-btn ps-next", "›");
    [prev, next].forEach((b, i) => {
      b.type = "button"; b.tabIndex = -1; b.setAttribute("aria-hidden", "true");
      b.addEventListener("click", () => row.scrollBy({ left: (i ? 1 : -1) * row.clientWidth * 0.7, behavior: "smooth" }));
    });
    const upd = () => {
      const max = row.scrollWidth - row.clientWidth;
      wrap.classList.toggle("at-start", row.scrollLeft <= 2);
      wrap.classList.toggle("at-end", row.scrollLeft >= max - 2);
    };
    row.addEventListener("scroll", upd, { passive: true });
    if (window.ResizeObserver) new ResizeObserver(upd).observe(row); else window.addEventListener("resize", upd);
    // Mouse wheel scrolls the row sideways.
    row.addEventListener("wheel", (e) => {
      if (Math.abs(e.deltaY) <= Math.abs(e.deltaX) || row.scrollWidth <= row.clientWidth) return;
      const max = row.scrollWidth - row.clientWidth;
      if ((e.deltaY < 0 && row.scrollLeft <= 0) || (e.deltaY > 0 && row.scrollLeft >= max)) return;
      row.scrollLeft += e.deltaY; e.preventDefault();
    }, { passive: false });
    // Mouse drag scrolls it too (touch already does). A drag doesn't count as a tap on a pill.
    let down = null, moved = false;
    row.addEventListener("pointerdown", (e) => { if (e.pointerType === "mouse") { down = { x: e.clientX, l: row.scrollLeft }; moved = false; } });
    window.addEventListener("pointermove", (e) => { if (!down) return; const dx = e.clientX - down.x; if (Math.abs(dx) > 5) moved = true; if (moved) row.scrollLeft = down.l - dx; });
    window.addEventListener("pointerup", () => { down = null; });
    row.addEventListener("click", (e) => { if (moved) { e.stopPropagation(); e.preventDefault(); moved = false; } }, true);
    wrap.append(row, prev, next);
    setTimeout(upd, 0);
    return wrap;
  }

  // Small helpers for the song request box.
  function readStore(k) { try { return localStorage.getItem(k); } catch (e) { return null; } }
  function writeStore(k, v) { try { localStorage.setItem(k, v); } catch (e) {} }
  function readReqs() { try { const v = JSON.parse(readStore("oke-requests") || "[]"); return Array.isArray(v) ? v : []; } catch (e) { return []; } }
  function writeReqs(v) { writeStore("oke-requests", JSON.stringify(v)); }
  function deviceId() {
    let d = readStore("oke-device");
    if (!/^[a-f0-9]{32}$/.test(d || "")) { const a = new Uint8Array(16); crypto.getRandomValues(a); d = [...a].map((x) => x.toString(16).padStart(2, "0")).join(""); writeStore("oke-device", d); }
    return d;
  }

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const key = (s) => (s || "").trim().toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, " ").trim();
  const songKey = (title, artist) => key(title) + "|" + key(artist);

  function readList() {
    try { const v = JSON.parse(localStorage.getItem(STORE) || "[]"); if (Array.isArray(v)) return v.filter((x) => x && x.t); } catch (e) {}
    return memory;
  }
  function writeList(list) { memory = list; try { localStorage.setItem(STORE, JSON.stringify(list)); } catch (e) {} }

  function mount(opts) {
    const find = opts.find, mine = opts.mine;
    let list = readList();
    let q = "", page = 0, results = [], more = false, ready = null, total = 0, ctrl = null, timer = null;

    // ---- find ----
    find.replaceChildren();
    const sw = el("div", "search-wrap");
    const input = el("input", "search"); Object.assign(input, { type: "text", placeholder: "Song or artist", autocomplete: "off", spellcheck: false });
    input.setAttribute("inputmode", "search"); input.setAttribute("enterkeyhint", "search"); input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", "Search the song catalog");
    const clear = el("button", "search-clear", "×"); clear.type = "button"; clear.hidden = true; clear.setAttribute("aria-label", "Clear search");
    sw.append(input, clear);
    // Filters, all sent to /api/catalog: a row of genre pills, a row of era pills, quick toggles,
    // and "More" (language, sort, every other genre). Tapping a lit pill turns it off.
    const f = { duo: false, hits: false, voice: "", genre: "", decade: "", lang: "", sort: "pop" };
    const pills = (cls, items, k, label) => {
      const row = el("div", "pills " + cls); row.setAttribute("role", "group"); row.setAttribute("aria-label", label);
      const btns = items.map(([v, text, hue]) => {
        const b = el("button", "sb-pill", text); b.type = "button"; b.dataset.v = v;
        if (hue != null) b.style.setProperty("--h", hue);
        b.addEventListener("click", () => { f[k] = f[k] === v ? "" : v; sync(); filtersChanged(); });
        row.append(b); return b;
      });
      return { row, btns, k };
    };
    const genreName = (g) => GENRE_LABEL[g] || g;
    const genres = pills("genres", FEATURED.map(([g, e], i) => [g, e + " " + genreName(g), (i * 37) % 360]), "genre", "Genre");
    const moreG = el("button", "sb-pill more-pill", "＋ More genres"); moreG.type = "button"; moreG.setAttribute("aria-expanded", "false");
    genres.row.append(moreG);
    const eras = pills("eras", DECADES.map((d) => [String(d), d === 1900 ? "Oldies" : d >= 2000 ? d + "s" : "’" + String(d).slice(2) + "s", null]), "decade", "Era");
    const quick = el("div", "pills quick");
    const quickToggle = (text, k) => {
      const b = el("button", "sb-pill", text); b.type = "button";
      b.addEventListener("click", () => { f[k] = !f[k]; sync(); filtersChanged(); });
      quick.append(b); return b;
    };
    const duoBtn = quickToggle("👯 Duets", "duo");
    // Singer's voice, from MusicBrainz (see voice_import.js). One at a time; tapping the lit one turns it off.
    const voiceBtns = VOICES.map(([v, text]) => {
      const b = el("button", "sb-pill", text); b.type = "button"; b.dataset.v = v;
      b.addEventListener("click", () => { f.voice = f.voice === v ? "" : v; sync(); filtersChanged(); });
      quick.append(b); return b;
    });
    const hitsBtn = quickToggle("🔥 Top 1,000", "hits");
    const moreBtnF = el("button", "sb-pill", "⚙️ More"); moreBtnF.type = "button"; moreBtnF.setAttribute("aria-expanded", "false");
    const clearF = el("button", "sb-pill clear-pill", "✕ Clear"); clearF.type = "button"; clearF.hidden = true;
    quick.append(moreBtnF, clearF);
    // "More": every other genre, language and sort, as wrapping pills.
    const panel = el("div", "cat-more"); panel.hidden = true;
    const otherG = pills("wrap", GENRES.filter((g) => !FEATURED.some(([x]) => x === g)).map((g) => [g, genreName(g), null]), "genre", "More genres");
    const langs = pills("wrap", LANGS.map((l) => [l, l, null]), "lang", "Language");
    const sorts = pills("wrap", SORT_OPTS.map(([v, t]) => [v, t, null]), "sort", "Sort");
    panel.append(el("div", "me-kicker", "More genres"), otherG.row, el("div", "me-kicker", "Language"), langs.row, el("div", "me-kicker", "Sort"), sorts.row);
    const showPanel = (on) => { panel.hidden = !on; moreBtnF.setAttribute("aria-expanded", String(on)); moreG.setAttribute("aria-expanded", String(on)); };
    moreBtnF.addEventListener("click", () => showPanel(panel.hidden));
    moreG.addEventListener("click", () => showPanel(true));
    const groups = [genres, eras, otherG, langs, sorts];
    function sync() {
      if (!f.sort) f.sort = "pop"; // tapping the lit sort pill goes back to the default
      groups.forEach((g) => g.btns.forEach((b) => b.setAttribute("aria-pressed", String(f[g.k] === b.dataset.v && !(g.k === "sort" && f.sort === "pop")))));
      duoBtn.setAttribute("aria-pressed", String(f.duo)); voiceBtns.forEach((b) => b.setAttribute("aria-pressed", String(f.voice === b.dataset.v))); hitsBtn.setAttribute("aria-pressed", String(f.hits));
      moreBtnF.classList.toggle("dot", !!(f.lang || f.sort !== "pop" || (f.genre && !FEATURED.some(([x]) => x === f.genre))));
      clearF.hidden = !filtersOn();
    }
    function filtersOn() { return f.duo || f.hits || f.voice || f.genre || f.decade || f.lang || f.sort !== "pop"; }
    function filtersChanged() { search(false); }
    clearF.addEventListener("click", () => { Object.assign(f, { duo: false, hits: false, voice: "", genre: "", decade: "", lang: "", sort: "pop" }); sync(); filtersChanged(); });
    sync();
    const filters = el("div", "cat-filters"); filters.append(scroller(genres.row), scroller(eras.row), scroller(quick), panel);
    const note = el("p", "muted small cat-note"); note.setAttribute("role", "status");
    // With no search words, the top 10 show as a swipeable row of album covers above the list.
    const topWrap = el("div", "cat-top-wrap"); topWrap.hidden = true;
    const topH = el("h2", "cat-top-h"), top = el("ol", "cat-top");
    topWrap.append(topH, top);
    const ol = el("ol", "list songs");
    const moreBtn = el("button", "act ghost more", "Show more"); moreBtn.type = "button"; moreBtn.hidden = true;
    find.append(sw, filters, note, topWrap, ol, moreBtn, requestBox());
    if (window.OkeArt) find.append(OkeArt.credit());

    // ---- my list ----
    mine.replaceChildren();
    const mineTodo = el("ol", "list songs"), mineDone = el("ol", "list songs");
    const doneH = el("h2", null, "Already sang");
    const mineNote = el("p", "muted small", "");
    const btns = el("div", "btns");
    const shareBtn = el("button", "act", "Share my list"); shareBtn.type = "button";
    const clearDone = el("button", "act ghost", "Clear sung songs"); clearDone.type = "button";
    btns.append(shareBtn, clearDone);
    const empty = el("button", "find-me");
    empty.type = "button";
    empty.append(el("span", "fm-ic", "📝"));
    const et = el("span"); et.append(el("b", null, "Nothing on your list yet"), el("span", "small", "Search for songs and tap ＋ to save the ones you want to sing."));
    empty.append(et); empty.firstChild.setAttribute("aria-hidden", "true");
    empty.addEventListener("click", () => { if (opts.onPick) opts.onPick(); input.focus(); });
    const todoSec = el("div", "sec"), doneSec = el("div", "sec");
    todoSec.append(el("h2", null, "Songs I want to sing"), mineNote, empty, mineTodo, btns);
    doneSec.append(doneH, mineDone);
    mine.append(todoSec, doneSec);

    // ---- helpers ----
    function sungIndex() {
      const byId = new Map(), byKey = new Map();
      (opts.getPlays() || []).forEach((p) => {
        if (p.song_id) byId.set(Number(p.song_id), (byId.get(Number(p.song_id)) || 0) + 1);
        if (p.title) { const k = songKey(p.title, p.artist); byKey.set(k, (byKey.get(k) || 0) + 1); }
      });
      return (s) => (s.id && byId.get(Number(s.id))) || byKey.get(songKey(s.title || s.t, s.artist || s.a)) || 0;
    }
    const inList = (s) => list.find((x) => (s.id && x.id === s.id) || songKey(x.t, x.a) === songKey(s.title, s.artist));
    // A song counts as sung once "That's me" sang it after adding it (or it was ticked by hand).
    function sungAt(item) {
      if (item.done) return item.done;
      const rows = (opts.getMyRows && opts.getMyRows()) || [];
      const r = rows.find((p) => p.played_at * 1000 >= item.at - 60000 &&
        ((item.id && Number(p.song_id) === item.id) || songKey(p.title, p.artist) === songKey(item.t, item.a)));
      return r ? r.played_at * 1000 : 0;
    }

    function toggle(s) {
      const have = inList(s);
      if (have) list = list.filter((x) => x !== have);
      else {
        if (list.length >= MAX_LIST) { note.textContent = "Your list is full (" + MAX_LIST + " songs). Clear some first."; return; }
        list = list.concat([{ id: s.id || null, t: s.title, a: s.artist || "", y: s.year || null, duo: !!s.duo, at: Date.now(), done: 0 }]);
      }
      writeList(list); renderResults(); renderMine();
    }

    function meta(s, count) {
      const bits = [s.artist || s.a, s.year || s.y].filter(Boolean);
      if (s.styles) bits.push(s.styles.split(",").filter((x) => x !== "Duet").slice(0, 2).map((x) => GENRE_LABEL[x] || x).join("/"));
      if (s.duo) bits.push("Duet");
      if (s.explicit) bits.push("Explicit");
      if (count) bits.push("sung here " + count + "×");
      return bits.join(" · ");
    }

    function addButton(s) {
      const on = !!inList(s);
      const b = el("button", "add" + (on ? " on" : ""), on ? "✓" : "＋"); b.type = "button";
      b.setAttribute("aria-pressed", String(on));
      b.setAttribute("aria-label", (on ? "Remove " : "Add ") + "“" + s.title + "” " + (on ? "from" : "to") + " my list");
      b.addEventListener("click", () => toggle(s));
      return b;
    }

    function renderResults() {
      ol.replaceChildren(); top.replaceChildren();
      const sung = sungIndex();
      const carousel = !q && ready && results.length >= 6;
      topWrap.hidden = !carousel;
      if (carousel) {
        topH.textContent = topTitle();
        results.slice(0, 10).forEach((s, i) => {
          const li = el("li", "top-card");
          const cover = window.OkeArt ? OkeArt.el(s, { big: true, cls: "top-art" }) : el("span", "art top-art");
          const rank = el("span", "top-rank", String(i + 1)); rank.setAttribute("aria-hidden", "true");
          const add = addButton(s); add.classList.add("top-add");
          const fig = el("div", "top-fig"); fig.append(cover, rank, add);
          li.append(fig, el("span", "top-t", s.title), el("span", "top-a", s.artist || ""));
          top.append(li);
        });
      }
      (carousel ? results.slice(10) : results).forEach((s) => {
        const li = el("li");
        const m = el("span", "sub-t", meta(s, sung(s)));
        li.append(el("span", "main-t", s.title), addButton(s), m);
        if (window.OkeArt) OkeArt.row(li, s);
        ol.append(li);
      });
      ol.hidden = !ol.children.length;
      moreBtn.hidden = !more;
    }
    // "Top 10 Country", "Top 10 ’90s duets", "Top 10 right now"
    function topTitle() {
      if (f.sort === "new") return "Just added";
      const bits = [];
      if (f.lang) bits.push(f.lang);
      if (f.genre) bits.push(genreName(f.genre));
      if (f.duo && f.voice !== "mix") bits.push("duets");
      const era = f.decade ? (f.decade === "1900" ? "oldies" : f.decade >= "2000" ? f.decade + "s" : "’" + f.decade.slice(2) + "s") : "";
      const tail = [era, VOICE_WORDS[f.voice]].filter(Boolean);
      if (!bits.length && !tail.length) return "Top 10 right now";
      return "Top 10 " + [bits.join(" "), ...tail].filter(Boolean).join(" · ");
    }

    function renderMine() {
      const items = list.map((x) => ({ x, d: sungAt(x) }));
      const todo = items.filter((i) => !i.d), done = items.filter((i) => i.d).sort((a, b) => b.d - a.d);
      const sung = sungIndex();
      const row = (i, isDone) => {
        const x = i.x, li = el("li");
        const tick = el("button", "add" + (isDone ? " on" : ""), isDone ? "✓" : "○"); tick.type = "button";
        tick.setAttribute("aria-pressed", String(isDone));
        tick.setAttribute("aria-label", (isDone ? "Move “" + x.t + "” back to my list" : "Mark “" + x.t + "” as sung"));
        tick.addEventListener("click", () => { x.done = isDone ? 0 : Date.now(); if (isDone) x.at = Date.now(); writeList(list); renderMine(); renderResults(); });
        const rm = el("button", "rm", "×"); rm.type = "button"; rm.setAttribute("aria-label", "Remove “" + x.t + "” from my list");
        rm.addEventListener("click", () => { list = list.filter((y) => y !== x); writeList(list); renderMine(); renderResults(); });
        const acts = el("span", "acts"); acts.append(tick, rm);
        li.append(el("span", "main-t", x.t), acts, el("span", "sub-t", meta(x, sung(x))));
        if (window.OkeArt) OkeArt.row(li, x);
        return li;
      };
      mineTodo.replaceChildren(...todo.map((i) => row(i, false)));
      mineDone.replaceChildren(...done.map((i) => row(i, true)));
      mineTodo.hidden = !todo.length; empty.hidden = !!list.length;
      btns.hidden = !todo.length; clearDone.hidden = !done.length;
      doneSec.hidden = !done.length;
      mineNote.textContent = list.length ? "Saved on this phone. Songs tick off by themselves when you sing them, if you picked your name with “That’s me”." : "";
      mineNote.hidden = !list.length;
      if (opts.count) opts.count.textContent = todo.length ? String(todo.length) : "";
    }

    // Until the first catalog import finishes, search the songs already sung here.
    function localSearch(words) {
      const seen = new Map(), sung = sungIndex();
      (opts.getPlays() || []).forEach((p) => {
        if (!p.title) return;
        const k = songKey(p.title, p.artist);
        if (!seen.has(k)) seen.set(k, { id: p.song_id ? Number(p.song_id) : null, title: p.title, artist: p.artist || "", year: p.release_year || null, hay: key(p.title + " " + (p.artist || "")) });
      });
      const ws = key(words).split(" ").filter(Boolean);
      return [...seen.values()].filter((s) => ws.every((w) => s.hay.split(" ").some((h) => h.startsWith(w))))
        .sort((a, b) => sung(b) - sung(a)).slice(0, 60);
    }

    async function search(append) {
      if (ctrl) ctrl.abort();
      ctrl = new AbortController();
      const mySeq = ctrl;
      if (!append) page = 0;
      note.textContent = "Searching…";
      try {
        const p = new URLSearchParams({ q });
        if (f.duo) p.set("duo", "1"); if (f.hits) p.set("hits", "1");
        ["voice", "genre", "decade", "lang"].forEach((k) => { if (f[k]) p.set(k, f[k]); });
        if (f.sort !== "pop") p.set("sort", f.sort);
        if (page) p.set("page", page);
        const u = "/api/catalog?" + p;
        const r = await fetch(u, { signal: ctrl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        if (mySeq !== ctrl) return;
        ready = d.ready; total = d.count;
        if (!d.ready) {
          results = localSearch(q).filter((s) => !f.duo || s.duo); more = false;
          note.textContent = results.length ? "The full song list isn’t loaded yet, so these are songs sung here." :
            (q ? "Nothing sung here matches “" + q + "” yet. The full song list is coming soon." : "The full song list is coming soon.");
        } else {
          results = append ? results.concat(d.songs) : d.songs; more = d.more;
          if (!results.length) note.textContent = "No songs match " + (q ? "“" + q + "”" + (filtersOn() ? " with these filters" : "") + ". Try fewer words, or request it below." : "these filters. Try loosening one.");
          else if (!q && !filtersOn()) note.textContent = "Most popular of " + total.toLocaleString("en-US") + " songs. Search or filter to find more.";
          else note.textContent = describe() + "." + (f.voice && d.voice && d.voice.done < d.voice.total ?
            " Singer voices are still being looked up (" + Math.floor(100 * d.voice.done / d.voice.total) + "% of artists so far), so more songs will show up." : f.voice ? " Bands aren’t sorted by voice yet." : "");
        }
        renderResults();
      } catch (e) {
        if (e.name === "AbortError") return;
        results = localSearch(q); more = false;
        note.textContent = "Can’t reach the song list right now." + (results.length ? " Showing songs sung here." : "");
        renderResults();
      }
    }

    input.addEventListener("input", () => {
      clear.hidden = !input.value;
      clearTimeout(timer);
      timer = setTimeout(() => { const v = input.value.trim(); if (v !== q) { q = v; search(false); } }, 250);
    });
    input.addEventListener("keydown", (e) => { if (e.key === "Enter") { clearTimeout(timer); q = input.value.trim(); search(false); input.blur(); } });
    clear.addEventListener("click", () => { input.value = ""; clear.hidden = true; q = ""; search(false); input.focus(); });
    // "Country duets from the 1990s matching “love”, most popular first"
    function describe() {
      let what = (f.genre ? (GENRE_LABEL[f.genre] || f.genre) + " " : "") + (f.lang ? f.lang + "-language " : "") + (f.voice === "mix" ? "guy + girl duets" : f.duo ? "duets" : "songs");
      if (f.voice === "m" || f.voice === "f") what += " by " + VOICE_WORDS[f.voice];
      if (f.hits) what = "Top 1,000 " + what; else what = what[0].toUpperCase() + what.slice(1);
      if (f.decade) what += f.decade === "1900" ? " from before 1950" : " from the " + f.decade + "s";
      if (q) what += " matching “" + q + "”";
      return what + ", " + (SORT_OPTS.find((o) => o[0] === f.sort) || SORT_OPTS[0])[2];
    }
    moreBtn.addEventListener("click", () => { page++; search(true); });

    // ---- request a song that isn't in the list (goes to the host, see requests_api.js) ----
    function requestBox() {
      const box = el("div", "card req");
      const open = el("button", "act ghost req-open", "🙋 Request a song"); open.type = "button";
      const lead = el("p", "req-lead"); lead.append(el("b", null, "Can’t find your song?"), document.createTextNode(" Ask the host to add it."));
      const form = el("form", "req-form"); form.hidden = true;
      const field = (label, max, ph) => { const l = el("label", "req-l", label), i = el("input", "search"); Object.assign(i, { maxLength: max, placeholder: ph, autocomplete: "off" }); l.append(i); form.append(l); return i; };
      const tIn = field("Song title", 100, "e.g. Dancing Queen"), aIn = field("Artist", 80, "e.g. ABBA"), nIn = field("Your name (optional)", 24, "So the host knows who asked");
      tIn.required = true;
      const send = el("button", "act", "Send to the host"); send.type = "submit";
      const cancel = el("button", "act ghost", "Cancel"); cancel.type = "button";
      const row = el("div", "btns"); row.append(send, cancel); form.append(row);
      const msg = el("p", "muted small req-msg"); msg.setAttribute("role", "status"); msg.hidden = true;
      const mineH = el("div", "me-kicker", "Your requests"), mineL = el("ul", "req-mine");
      box.append(lead, open, form, msg, mineH, mineL);
      const show = (on) => {
        form.hidden = !on; open.hidden = on;
        if (on) { if (!tIn.value && q) tIn.value = q; if (!nIn.value) nIn.value = readStore("oke-react-name") || ""; tIn.focus(); }
      };
      open.addEventListener("click", () => { msg.hidden = true; show(true); });
      cancel.addEventListener("click", () => show(false));
      form.addEventListener("submit", async (e) => {
        e.preventDefault(); send.disabled = true; msg.hidden = false; msg.textContent = "Sending…";
        try {
          const r = await fetch("/api/request", { method: "POST", headers: { "content-type": "application/json" },
            body: JSON.stringify({ title: tIn.value, artist: aIn.value, name: nIn.value, dev: deviceId() }) });
          const d = await r.json();
          if (!r.ok) throw new Error(d.error || "That didn’t go through.");
          msg.textContent = d.merged ? "Someone already asked for that one, so your vote was added. 🎤" : "Sent to the host! 🎤 You’ll see here if it gets added.";
          const mine = readReqs().filter((x) => x.id !== d.id);
          mine.unshift({ id: d.id, t: tIn.value.trim(), a: aIn.value.trim(), s: "open" }); writeReqs(mine.slice(0, 20));
          if (nIn.value.trim()) writeStore("oke-react-name", nIn.value.trim());
          tIn.value = ""; aIn.value = ""; show(false); renderReqs();
        } catch (err) { msg.textContent = err.message || "That didn’t go through. Try again in a bit."; }
        send.disabled = false;
      });
      const LABEL = { open: "⏳ Asked", added: "✅ Added, go sign up!", unavailable: "❌ Not available" };
      function renderReqs() {
        const mine = readReqs();
        mineH.hidden = mineL.hidden = !mine.length;
        mineL.replaceChildren(...mine.map((x) => { const li = el("li");
          li.append(el("span", "req-t", x.t + (x.a ? " – " + x.a : "")), el("span", "req-s req-" + x.s, LABEL[x.s] || LABEL.open)); return li; }));
      }
      async function refreshReqs() {
        const mine = readReqs(), ids = mine.filter((x) => x.s === "open").map((x) => x.id);
        if (!ids.length) return;
        try {
          const d = await (await fetch("/api/request?ids=" + ids.join(","))).json();
          const st = new Map((d.requests || []).map((r) => [r.id, r.status]));
          writeReqs(mine.filter((x) => x.s !== "open" || st.has(x.id)).map((x) => st.has(x.id) ? { ...x, s: st.get(x.id) } : x));
          renderReqs();
        } catch (e) {}
      }
      renderReqs(); setTimeout(refreshReqs, 1500);
      return box;
    }
    clearDone.addEventListener("click", () => { list = list.filter((x) => !sungAt(x)); writeList(list); renderMine(); renderResults(); });
    shareBtn.addEventListener("click", async () => {
      const todo = list.filter((x) => !sungAt(x));
      const text = "Songs I want to sing 🎤\n" + todo.map((x, i) => (i + 1) + ". " + x.t + (x.a ? " – " + x.a : "")).join("\n");
      if (navigator.share) { try { await navigator.share({ title: "My karaoke list", text }); } catch (e) {} return; }
      try { await navigator.clipboard.writeText(text); shareBtn.textContent = "List copied"; setTimeout(() => { shareBtn.textContent = "Share my list"; }, 2000); } catch (e) {}
    });
    // Another tab on this phone changed the list.
    window.addEventListener("storage", (e) => { if (e.key === STORE) { list = readList(); renderMine(); renderResults(); } });

    let started = false;
    renderMine();
    return {
      // Called when the Songbook tab opens, so phones that never open it don't search.
      start() { if (!started) { started = true; search(false); } },
      refresh() { renderMine(); if (started && ready === false) results = localSearch(q).filter((s) => !f.duo || s.duo); renderResults(); },
    };
  }

  global.OkeSongs = { mount };
})(window);
