// Duet finder on the Tonight tab: post a duet you want to sing, or tap "I'm in" on someone else's.
// Server side is duets_api.js; the board comes with /api/plays (data.duets) so it updates with the page.
//
// OkeDuets.mount({ box, deviceId, getName, setName }) -> { update(data) }
//   getName()/setName(n): the name this phone uses for reactions and the crowd draft
(function (global) {
  const MINE = "oke-duets-mine"; // ids this phone posted or joined, so it can show "Cancel" on them
  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const readMine = () => { try { return new Set(JSON.parse(localStorage.getItem(MINE) || "[]")); } catch (e) { return new Set(); } };
  const writeMine = (s) => { try { localStorage.setItem(MINE, JSON.stringify([...s].slice(-20))); } catch (e) {} };

  function mount(opts) {
    const box = opts.box;
    let duets = [], mine = readMine(), holdUntil = 0, busy = false;
    box.replaceChildren();
    const h = el("h2", null, "Duet finder"); const aside = el("span", "aside"); h.append(aside);
    const intro = el("p", "muted small dr-intro", "Got a duet in mind but no partner? Post it here. When someone taps “I’m in”, you both get the match. Then sign up together at the booth.");
    const go = el("button", "act dr-go", "🤝 Find a duet partner"); go.type = "button";
    const msg = el("p", "muted small dr-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const ol = el("ol", "list dr-list");
    box.append(h, intro, go, msg, ol);

    async function post(body) {
      const r = await fetch("api/duet", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, dev: opts.deviceId }) });
      const d = await r.json().catch(() => ({}));
      if (Array.isArray(d.duets)) { duets = d.duets; holdUntil = Date.now() + 20000; }
      return { ok: r.ok, d };
    }
    function askName() {
      let n = (opts.getName && opts.getName()) || "";
      if (!n) { n = (prompt("Your name, so your duet partner can find you:") || "").trim().slice(0, 24); if (n && opts.setName) opts.setName(n); }
      return n;
    }

    function render() {
      const open = duets.filter((d) => !d.partner), matched = duets.filter((d) => d.partner);
      aside.textContent = duets.length ? (open.length ? open.length + " looking" : "") + (open.length && matched.length ? " · " : "") + (matched.length ? matched.length + " matched" : "") : "";
      ol.replaceChildren(); ol.hidden = !duets.length;
      matched.concat(open).forEach((d) => {
        const li = el("li", d.partner ? "dr-done" : ""), isMine = mine.has(d.id);
        li.append(el("span", "rank" + (d.partner ? " medal" : ""), d.partner ? "🤝" : "🎤"));
        const main = el("span", "main-t");
        if (d.partner) main.append(el("b", null, d.by + " + " + d.partner), document.createTextNode(" · “" + d.title + "”"));
        else main.append(el("b", null, d.by), document.createTextNode(" needs a partner for “" + d.title + "”"));
        const b = el("button", "dr-vote" + (isMine ? "" : " on"), isMine ? "Cancel" : d.partner ? "Matched" : "I’m in"); b.type = "button";
        b.disabled = !isMine && !!d.partner;
        b.addEventListener("click", () => (isMine ? cancel(d) : join(d)));
        li.append(main, b, el("span", "sub-t", [d.artist, d.partner ? (isMine ? "It’s a match! Go sign up together at the booth." : "Matched") : null].filter(Boolean).join(" · ")));
        if (window.OkeArt) OkeArt.row(li, d);
        ol.append(li);
      });
      const EMPTY = "No duets posted yet. Be the first!";
      if (!duets.length) msg.textContent = EMPTY; else if (msg.textContent === EMPTY) msg.textContent = "";
    }
    async function join(d) {
      if (busy) return; const name = askName(); if (!name) return; busy = true;
      try { const r = await post({ action: "join", id: d.id, name }); if (r.ok) { mine.add(d.id); writeMine(mine); msg.textContent = "You’re in! Find " + d.by + " and sign up together."; } else msg.textContent = r.d.error || "That didn’t go through."; }
      catch (e) { msg.textContent = "Couldn’t reach the site. Try again."; }
      busy = false; render();
    }
    async function cancel(d) {
      if (busy) return; busy = true;
      try { const r = await post({ action: "cancel", id: d.id }); if (r.ok) { mine.delete(d.id); writeMine(mine); msg.textContent = "Done."; } else msg.textContent = r.d.error || "That didn’t go through."; }
      catch (e) { msg.textContent = "Couldn’t reach the site. Try again."; }
      busy = false; render();
    }

    // ---- post dialog: search duets (the song list marks duets), tap one to post ----
    const dlg = el("dialog", "dr-dlg"); dlg.setAttribute("aria-labelledby", "du-h");
    const dh = el("h3", null, "Find a duet partner"); dh.id = "du-h";
    const step = el("p", "muted small", "Pick the duet you want to sing. Popular duets show first.");
    const sw = el("div", "search-wrap");
    const input = el("input", "search"); Object.assign(input, { type: "text", autocomplete: "off", spellcheck: false, placeholder: "Song or artist" });
    input.setAttribute("aria-label", "Search duets"); input.setAttribute("enterkeyhint", "search");
    sw.append(input);
    const nameL = el("label", "muted small", "Your name");
    const nameIn = el("input", "search"); Object.assign(nameIn, { type: "text", maxLength: 24, placeholder: "So your partner can find you", autocomplete: "nickname" });
    nameL.append(nameIn);
    const picks = el("ol", "list dr-picks");
    const err = el("p", "dr-err"); err.setAttribute("role", "alert");
    const btns = el("div", "btns"); const close = el("button", "act ghost", "Close"); close.type = "button"; btns.append(close);
    dlg.append(dh, step, nameL, sw, picks, err, btns);
    document.body.append(dlg);
    close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });
    let timer = null, ctrl = null;
    async function search() {
      if (ctrl) ctrl.abort(); ctrl = new AbortController(); const me = ctrl;
      const q = input.value.trim();
      try {
        const r = await fetch("api/catalog?duo=1&sort=pop&q=" + encodeURIComponent(q), { signal: me.signal });
        const d = await r.json(); if (me !== ctrl) return;
        const songs = (d.songs || []).slice(0, 30);
        picks.replaceChildren(...songs.map((s) => {
          const li = el("li"), b = el("button", "dr-pick"); b.type = "button";
          b.append(el("span", "main-t", s.title), el("span", "sub-t", [s.artist, s.year].filter(Boolean).join(" · ")));
          b.addEventListener("click", () => send(s)); li.append(b); return li;
        }));
        if (!songs.length) picks.append(el("li", "muted small dr-none", d.ready === false ? "The song list is still loading. Try again in a bit." : "No duets match “" + q + "”."));
      } catch (e) { if (e.name !== "AbortError") picks.replaceChildren(el("li", "muted small dr-none", "Can’t reach the song list right now.")); }
    }
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(search, 250); });
    async function send(s) {
      const name = nameIn.value.trim().slice(0, 24);
      if (!name) { err.textContent = "Add your name first."; nameIn.focus(); return; }
      if (opts.setName) opts.setName(name);
      err.textContent = "";
      try {
        const r = await post({ action: "post", song: s.id, name });
        if (!r.ok) { err.textContent = r.d.error || "That didn’t go through."; return; }
        mine.add(r.d.id); writeMine(mine); dlg.close(); msg.textContent = "Posted! You’ll see it here when someone joins."; render();
      } catch (e) { err.textContent = "Couldn’t reach the site. Try again."; }
    }
    go.addEventListener("click", () => { nameIn.value = (opts.getName && opts.getName()) || ""; input.value = ""; err.textContent = ""; dlg.showModal(); search(); });

    render();
    return {
      update(data) {
        if (Date.now() < holdUntil) return; // keep a fresher board from our own post until the edge cache catches up
        const next = Array.isArray(data.duets) ? data.duets : [];
        // A match on one of mine that just happened: say so.
        const was = new Map(duets.map((d) => [d.id, d.partner]));
        next.forEach((d) => { if (mine.has(d.id) && d.partner && !was.get(d.id) && was.has(d.id)) msg.textContent = "🤝 It’s a match: " + d.by + " + " + d.partner + " for “" + d.title + "”!"; });
        duets = next; render();
      },
    };
  }
  global.OkeDuets = { mount };
})(window);
