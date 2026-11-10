// Crowd draft on the Tonight tab: draft someone who's sung here to sing a song, and second the picks you want most.
// Server side is drafts_api.js. The board comes with /api/plays (data.drafts), so it updates with the page.
// A pick is "delivered" once the drafted singer sings that song after it was picked (worked out here from plays).
//
// OkeDraft.mount({ box, getPlays, getPeople, deviceId, getName, setName, onChange })
//   box: the section to draw in; getPeople(): [{name, rows}] (people this site knows, canonical names)
//   getName()/setName(n): the name this phone uses for reactions ("drafted by")
// Returns { update(data), open(singerName), delivered(plays, drafts) }
(function (global) {
  const VOTES = "oke-draft-votes"; // {night: [draft ids this phone seconded]}
  const SECOND = 60;

  function el(tag, cls, text) { const e = document.createElement(tag); if (cls) e.className = cls; if (text != null) e.textContent = text; return e; }
  const skey = (s) => String(s || "").toLowerCase().replace(/[^a-z0-9]/g, "");
  const tkey = (s) => String(s || "").toLowerCase().replace(/\([^)]*\)|\[[^\]]*\]/g, " ").normalize("NFD").replace(/[^a-z0-9]/g, "");
  // "Dave & Sue" sang it: Dave counts.
  const partsOf = (s) => String(s || "").split(/\s*(?:&|\+|,|\/|\band\b|\bwith\b|\bx\b)\s*/i).map(skey).filter(Boolean);

  // Which drafts got sung: the drafted singer (alone or in a group) sang that song after the pick was made.
  function delivered(plays, drafts) {
    const out = new Map();
    (drafts || []).forEach((d) => {
      const k = skey(d.singer);
      const p = (plays || []).find((p) => p.played_at >= d.created_at - SECOND &&
        (skey(p.singer) === k || partsOf(p.as_typed || p.singer).includes(k)) &&
        ((d.song_id && Number(p.song_id) === Number(d.song_id)) || (p.title && tkey(p.title) === tkey(d.title))));
      if (p) out.set(d.id, p);
    });
    return out;
  }

  function readVotes(night) { try { const v = JSON.parse(localStorage.getItem(VOTES) || "{}"); return new Set((v && v[night]) || []); } catch (e) { return new Set(); } }
  function writeVotes(night, set) { try { localStorage.setItem(VOTES, JSON.stringify({ [night]: [...set] })); } catch (e) {} }

  function mount(opts) {
    const box = opts.box;
    let night = null, drafts = [], plays = [], votes = new Set(), busy = false, holdUntil = 0;

    // ---- board ----
    box.replaceChildren();
    const h = el("h2", null, "Crowd draft"); const aside = el("span", "aside"); h.append(aside);
    const intro = el("p", "muted small dr-intro", "Draft someone who’s sung here to sing a song. Second the picks you want to hear and the top ones rise. The host makes the call!");
    const draftBtn = el("button", "act dr-go", "🎯 Draft a singer"); draftBtn.type = "button";
    const msg = el("p", "muted small dr-msg"); msg.setAttribute("role", "status"); msg.setAttribute("aria-live", "polite");
    const ol = el("ol", "list dr-list");
    box.append(h, intro, draftBtn, msg, ol);
    draftBtn.addEventListener("click", () => open());

    function render() {
      const done = delivered(plays, drafts);
      const rows = drafts.slice().sort((a, b) => (done.has(b.id) ? 1 : 0) - (done.has(a.id) ? 1 : 0) || b.votes - a.votes || a.created_at - b.created_at);
      aside.textContent = drafts.length ? drafts.length + (drafts.length === 1 ? " pick" : " picks") + (done.size ? " · " + done.size + " delivered" : "") : "";
      ol.replaceChildren();
      ol.hidden = !rows.length;
      let rank = 0;
      rows.forEach((d) => {
        const got = done.get(d.id), li = el("li", got ? "dr-done" : "");
        li.append(el("span", "rank" + (got ? " medal" : ""), got ? "✅" : String(++rank)));
        const main = el("span", "main-t"); main.append(el("b", null, d.singer), document.createTextNode(" → “" + d.title + "”"));
        const mine = votes.has(d.id);
        const vb = el("button", "dr-vote" + (mine ? " on" : ""), "👍 " + d.votes); vb.type = "button";
        vb.setAttribute("aria-pressed", String(mine));
        vb.setAttribute("aria-label", (mine ? "Take back your second for " : "Second ") + d.singer + " singing " + d.title + ", " + d.votes + (d.votes === 1 ? " vote" : " votes"));
        if (got) vb.disabled = true;
        vb.addEventListener("click", () => vote(d, !mine));
        const sub = el("span", "sub-t", [d.artist, got ? "Delivered! 🎉" : "drafted by " + d.by].filter(Boolean).join(" · "));
        li.append(main, vb, sub);
        if (window.OkeArt) OkeArt.row(li, d); // album cover, see art.js
        ol.append(li);
      });
      if (!rows.length) msg.textContent = "No picks yet. Who do you want to hear, and what should they sing?";
    }

    async function post(body) {
      const r = await fetch("/api/draft", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ ...body, dev: opts.deviceId }) });
      const d = await r.json().catch(() => ({}));
      // /api/plays is cached for a few seconds, so keep this fresher board until the cache catches up.
      if (Array.isArray(d.board)) { drafts = d.board; holdUntil = Date.now() + 20000; }
      return { ok: r.ok, d };
    }

    async function vote(d, on) {
      if (busy) return; busy = true;
      // Show it right away; the server's board corrects it.
      if (on) votes.add(d.id); else votes.delete(d.id);
      d.votes += on ? 1 : -1; writeVotes(night, votes); render();
      try {
        const r = await post({ action: on ? "vote" : "unvote", id: d.id });
        msg.textContent = r.ok ? "" : r.d.error || "That didn’t go through.";
        if (!r.ok && on) { votes.delete(d.id); writeVotes(night, votes); }
      } catch (e) { msg.textContent = "Can’t reach the site right now."; }
      busy = false; render(); if (opts.onChange) opts.onChange();
    }

    // ---- the draft dialog: singer, then song, then send ----
    const dlg = el("dialog", "dr-dlg"); dlg.setAttribute("aria-labelledby", "dr-h");
    const dh = el("h3", null, "Draft a singer"); dh.id = "dr-h";
    const step = el("p", "muted small", "");
    const sw = el("div", "search-wrap");
    const input = el("input", "search"); Object.assign(input, { type: "text", autocomplete: "off", spellcheck: false });
    input.setAttribute("autocapitalize", "off"); input.setAttribute("enterkeyhint", "search");
    sw.append(input);
    const picks = el("ol", "list dr-picks");
    const confirmBox = el("div", "dr-confirm"); confirmBox.hidden = true;
    const card = el("div", "dr-card");
    const nameL = el("label", "muted small"); nameL.textContent = "Drafted by (optional)";
    const nameIn = el("input", "search"); Object.assign(nameIn, { type: "text", maxLength: 24, placeholder: "Your name", autocomplete: "nickname" });
    nameL.append(nameIn);
    const sendBtn = el("button", "act", "Draft them! 🎯"); sendBtn.type = "button";
    confirmBox.append(card, nameL, sendBtn);
    const err = el("p", "dr-err"); err.setAttribute("role", "alert");
    const btns = el("div", "btns");
    const back = el("button", "act ghost", "Back"); back.type = "button";
    const close = el("button", "act ghost", "Close"); close.type = "button";
    btns.append(back, close);
    dlg.append(dh, step, sw, picks, confirmBox, err, btns);
    document.body.append(dlg);
    close.addEventListener("click", () => dlg.close());
    dlg.addEventListener("click", (e) => { if (e.target === dlg) dlg.close(); });

    let stage = "singer", singer = null, song = null, timer = null, ctrl = null;

    function singers() {
      // People who've sung on their own (the server only accepts names KaraFun has seen), tonight's singers first.
      const solo = new Set((plays || []).map((p) => skey(p.singer)));
      const last = plays.length ? plays[plays.length - 1].night : null;
      return (opts.getPeople() || []).filter((e) => solo.has(skey(e.name))).map((e) => ({
        name: e.name, n: e.rows.length, tonight: e.rows.some((p) => p.night === last),
      })).sort((a, b) => b.tonight - a.tonight || b.n - a.n || a.name.localeCompare(b.name));
    }

    function showSingers() {
      const q = skey(input.value);
      const list = singers().filter((s) => !q || skey(s.name).includes(q)).slice(0, 40);
      picks.replaceChildren(...list.map((s) => {
        const li = el("li"), b = el("button", "dr-pick"); b.type = "button";
        b.append(el("span", "main-t", s.name), el("span", "sub-t", (s.tonight ? "Here tonight · " : "") + s.n + (s.n === 1 ? " song" : " songs") + " sung here"));
        b.addEventListener("click", () => { singer = s.name; go("song"); });
        li.append(b); return li;
      }));
      if (!list.length) picks.append(el("li", "muted small dr-none", q ? "Nobody by that name has sung here yet. Only people who’ve sung can be drafted." : "Nobody has sung yet."));
    }

    function songRow(s) {
      const li = el("li"), b = el("button", "dr-pick"); b.type = "button";
      b.append(el("span", "main-t", s.title), el("span", "sub-t", [s.artist, s.year, s.duo ? "Duet" : null].filter(Boolean).join(" · ")));
      b.addEventListener("click", () => { song = s; go("confirm"); });
      li.append(b); return li;
    }
    // Their own past songs, for a quick "sing it again" pick when the search is empty.
    function theirSongs() {
      const k = skey(singer), seen = new Set(), out = [];
      (plays || []).slice().reverse().forEach((p) => {
        if (skey(p.singer) !== k || !p.song_id || !p.title || seen.has(p.song_id)) return;
        seen.add(p.song_id); out.push({ id: Number(p.song_id), title: p.title, artist: p.artist || "", year: p.release_year || null });
      });
      return out.slice(0, 8);
    }
    async function searchSongs() {
      const q = input.value.trim();
      if (ctrl) ctrl.abort(); ctrl = new AbortController(); const me = ctrl;
      if (!q) {
        const mine = theirSongs();
        picks.replaceChildren();
        if (mine.length) { picks.append(el("li", "muted small dr-none", "Or an encore of one of theirs:")); mine.forEach((s) => picks.append(songRow(s))); }
        else picks.append(el("li", "muted small dr-none", "Search KaraFun’s whole catalog."));
        return;
      }
      try {
        const r = await fetch("/api/catalog?q=" + encodeURIComponent(q), { signal: me.signal });
        const d = await r.json();
        if (me !== ctrl) return;
        let songs = d.songs || [];
        if (!d.ready) { // catalog not loaded yet: songs sung here
          const ws = tkey(q), seen = new Set();
          songs = (plays || []).filter((p) => p.song_id && p.title && tkey(p.title + p.artist).includes(ws) && !seen.has(p.song_id) && seen.add(p.song_id))
            .slice(0, 30).map((p) => ({ id: Number(p.song_id), title: p.title, artist: p.artist || "", year: p.release_year || null }));
        }
        picks.replaceChildren(...songs.slice(0, 30).map(songRow));
        if (!songs.length) picks.append(el("li", "muted small dr-none", "No songs match “" + q + "”."));
      } catch (e) { if (e.name !== "AbortError") { picks.replaceChildren(el("li", "muted small dr-none", "Can’t reach the song list right now.")); } }
    }

    function go(next) {
      stage = next; err.textContent = "";
      const isPick = stage !== "confirm";
      sw.hidden = picks.hidden = !isPick; confirmBox.hidden = isPick;
      back.hidden = stage === "singer";
      if (stage === "singer") {
        dh.textContent = "Draft a singer"; step.textContent = "Step 1 of 2: who should sing?";
        input.placeholder = "Search singers"; input.setAttribute("aria-label", "Search singers"); input.value = ""; showSingers();
      } else if (stage === "song") {
        dh.textContent = "Draft " + singer; step.textContent = "Step 2 of 2: what should " + singer + " sing?";
        input.placeholder = "Song or artist"; input.setAttribute("aria-label", "Search songs"); input.value = ""; searchSongs();
      } else {
        dh.textContent = "Ready?";
        step.textContent = "This goes on the crowd draft board. The host decides if it happens.";
        card.replaceChildren(el("b", null, singer), el("span", null, "sings"), el("b", null, "“" + song.title + "”"), el("span", "muted small", song.artist || ""));
        nameIn.value = (opts.getName && opts.getName()) || "";
      }
      if (isPick) setTimeout(() => input.focus(), 30);
    }
    input.addEventListener("input", () => { clearTimeout(timer); timer = setTimeout(() => (stage === "singer" ? showSingers() : searchSongs()), stage === "singer" ? 60 : 250); });
    back.addEventListener("click", () => go(stage === "confirm" ? "song" : "singer"));
    sendBtn.addEventListener("click", async () => {
      if (busy) return; busy = true; sendBtn.disabled = true; err.textContent = "";
      const name = nameIn.value.trim();
      if (name && opts.setName) opts.setName(name);
      try {
        const r = await post({ action: "pick", singer, song: song.id, name });
        if (r.ok) {
          if (r.d.draft_id) { votes.add(r.d.draft_id); writeVotes(night, votes); }
          msg.textContent = r.d.dup ? "Someone already drafted that one, so you seconded it." : "Drafted! Tell your friends to second it.";
          dlg.close(); render(); if (opts.onChange) opts.onChange();
        } else err.textContent = r.d.error || "That didn’t go through.";
      } catch (e) { err.textContent = "Can’t reach the site right now."; }
      busy = false; sendBtn.disabled = false;
    });

    function open(name) {
      plays = opts.getPlays() || plays;
      singer = null; song = null;
      if (name && singers().some((s) => skey(s.name) === skey(name))) { singer = name; go("song"); } else go("singer");
      if (!dlg.open) dlg.showModal();
    }

    return {
      update(data) {
        plays = opts.getPlays() || [];
        if (data && Array.isArray(data.drafts) && (Date.now() > holdUntil || data.draft_night !== night)) {
          if (data.draft_night !== night) { night = data.draft_night; votes = readVotes(night); }
          drafts = data.drafts;
        }
        if (!busy) render();
      },
      open, delivered,
    };
  }

  global.OkeDraft = { mount, delivered };
})(window);
