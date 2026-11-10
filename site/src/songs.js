// Songbook tab: search KaraFun's catalog (/api/catalog) and keep a list of songs you want to sing.
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
    let q = "", duo = false, page = 0, results = [], more = false, ready = null, total = 0, ctrl = null, timer = null;

    // ---- find ----
    find.replaceChildren();
    const sw = el("div", "search-wrap");
    const input = el("input", "search"); Object.assign(input, { type: "text", placeholder: "Song or artist", autocomplete: "off", spellcheck: false });
    input.setAttribute("inputmode", "search"); input.setAttribute("enterkeyhint", "search"); input.setAttribute("autocapitalize", "off");
    input.setAttribute("aria-label", "Search the KaraFun song catalog");
    const clear = el("button", "search-clear", "×"); clear.type = "button"; clear.hidden = true; clear.setAttribute("aria-label", "Clear search");
    sw.append(input, clear);
    const filters = el("div", "band-row");
    const duoBtn = el("button", "band", "👯 Duets only"); duoBtn.type = "button"; duoBtn.setAttribute("aria-pressed", "false");
    filters.append(duoBtn);
    const note = el("p", "muted small cat-note"); note.setAttribute("role", "status");
    const ol = el("ol", "list songs");
    const moreBtn = el("button", "act ghost more", "Show more"); moreBtn.type = "button"; moreBtn.hidden = true;
    find.append(sw, filters, note, ol, moreBtn);

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
      ol.replaceChildren();
      const sung = sungIndex();
      results.forEach((s) => {
        const li = el("li");
        const m = el("span", "sub-t", meta(s, sung(s)));
        li.append(el("span", "main-t", s.title), addButton(s), m);
        ol.append(li);
      });
      ol.hidden = !results.length;
      moreBtn.hidden = !more;
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

    // Before the laptop has loaded KaraFun's catalog, search the songs already sung here.
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
        const u = "/api/catalog?q=" + encodeURIComponent(q) + (duo ? "&duo=1" : "") + (page ? "&page=" + page : "");
        const r = await fetch(u, { signal: ctrl.signal });
        if (!r.ok) throw new Error("HTTP " + r.status);
        const d = await r.json();
        if (mySeq !== ctrl) return;
        ready = d.ready; total = d.count;
        if (!d.ready) {
          results = localSearch(q).filter((s) => !duo || s.duo); more = false;
          note.textContent = results.length ? "KaraFun’s full song list isn’t loaded yet, so these are songs sung here." :
            (q ? "Nothing sung here matches “" + q + "” yet. The full KaraFun song list is coming soon." : "The full KaraFun song list is coming soon.");
        } else {
          results = append ? results.concat(d.songs) : d.songs; more = d.more;
          if (!results.length) note.textContent = "No KaraFun songs match “" + q + "”. Try fewer words.";
          else if (!q) note.textContent = (duo ? "Most popular duets" : "Most popular songs") + " in KaraFun’s " + total.toLocaleString("en-US") + "-song catalog. Search to find more.";
          else note.textContent = "KaraFun songs matching “" + q + "”, most popular first.";
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
    duoBtn.addEventListener("click", () => { duo = !duo; duoBtn.setAttribute("aria-pressed", String(duo)); search(false); });
    moreBtn.addEventListener("click", () => { page++; search(true); });
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
      refresh() { renderMine(); if (started && ready === false) results = localSearch(q).filter((s) => !duo || s.duo); renderResults(); },
    };
  }

  global.OkeSongs = { mount };
})(window);
