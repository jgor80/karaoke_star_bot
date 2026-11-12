// Album covers next to songs (phone page, Songbook and /tv). Covers come from /api/art (see art_api.js),
// which looks each song up once and remembers it. Until a cover loads, or when a song has none, the
// square shows a music note, so rows never jump around.
//
//   OkeArt.el(song, {big, cls})   -> a cover square. song needs an id (song_id or id) and a title.
//   OkeArt.row(elem, song, opts)  -> puts a cover at the left of a list row (adds the has-art class).
//   OkeArt.credit()               -> the "where covers come from" line for under a list of songs.
//   Tapping a loaded cover opens the song where the cover came from (/api/listen, usually Apple Music),
//   which is what lets us show the artwork.
//   OkeArt.put(slot, song, opts)  -> fills a fixed spot, like the hero, without reloading the same cover.
//                                    Returns false (and empties the spot) when the song has no id or title.
(function () {
  const css = `
.art { position: relative; display: inline-block; flex: none; width: 46px; height: 46px; border-radius: 8px; overflow: hidden;
  background: linear-gradient(135deg, #3b1d4a, #1d0f24); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); vertical-align: middle; }
.art::before { content: "♪"; position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.3); font-size: var(--art-note, 20px); }
.art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.art.ok img { opacity: 1; }
.art.ok { cursor: pointer; }
.art.ok::after { content: "▶"; position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; border-radius: 50%;
  display: grid; place-items: center; font-size: 8px; color: #fff; background: rgba(0,0,0,.55); }
.art-credit { margin: 8px 2px 0; font-size: 13px; color: var(--muted, #a99); }
.art-credit a { color: inherit; }
.has-art { position: relative; padding-left: 72px !important; min-height: 68px; }
.has-art > .art { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); }
.hero-art { position: absolute; top: 16px; right: 16px; z-index: 1; }
.hero-art .art { width: 84px; height: 84px; border-radius: 12px; box-shadow: 0 6px 18px rgba(0,0,0,.45), inset 0 0 0 1px rgba(255,255,255,.1); --art-note: 34px; }
.hero.has-cover .label, .hero.has-cover .who { margin-right: 96px; }
`;
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);

  // Must match norm() in art_api.js so every phone asks for the same URL and the edge cache answers.
  const normTitle = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 60);
  const idOf = (song) => Number(song && (song.song_id != null ? song.song_id : song.id)) || 0;
  const titleOf = (song) => (song && (song.title || song.t)) || "";
  function src(song, big) {
    // a=1: Apple-only covers, so phones drop images cached from the old sources.
    return "api/art?a=1&id=" + idOf(song) + "&t=" + encodeURIComponent(normTitle(titleOf(song))) + (big ? "&s=big" : "");
  }

  function el(song, opts) {
    opts = opts || {};
    const box = document.createElement("span");
    box.className = "art" + (opts.cls ? " " + opts.cls : "");
    box.setAttribute("aria-hidden", "true");
    if (idOf(song) > 0 && titleOf(song)) {
      const img = new Image();
      img.alt = ""; img.loading = "lazy"; img.decoding = "async"; img.referrerPolicy = "no-referrer";
      img.onload = () => {
        box.classList.add("ok"); box.removeAttribute("aria-hidden");
        box.setAttribute("role", "link"); box.tabIndex = 0;
        box.setAttribute("aria-label", "Listen to “" + titleOf(song) + "”");
        box.title = "Listen to this song";
      };
      const open = (e) => { if (!box.classList.contains("ok")) return; e.preventDefault(); e.stopPropagation();
        window.open("api/listen?id=" + idOf(song) + "&t=" + encodeURIComponent(normTitle(titleOf(song))), "_blank", "noopener"); };
      box.addEventListener("click", open);
      box.addEventListener("keydown", (e) => { if (e.key === "Enter" || e.key === " ") open(e); });
      img.onerror = () => img.remove();
      img.src = src(song, opts.big);
      box.append(img);
    }
    return box;
  }
  function row(elem, song, opts) { elem.classList.add("has-art"); elem.prepend(el(song, opts)); return elem; }
  // slot is an empty container. Returns true when it now shows a cover square.
  function put(slot, song, opts) {
    const k = song && idOf(song) > 0 && titleOf(song) ? idOf(song) + "|" + normTitle(titleOf(song)) : "";
    if (slot.dataset.artKey !== k) { slot.dataset.artKey = k; slot.replaceChildren(...(k ? [el(song, opts)] : [])); }
    return !!k;
  }
  // Keep in step with ART_SOURCES in wrangler.toml.
  function credit() {
    const p = document.createElement("p"); p.className = "art-credit";
    const a = document.createElement("a"); a.href = "https://music.apple.com/"; a.target = "_blank"; a.rel = "noopener"; a.textContent = "Apple Music";
    p.append("Album covers from ", a, ". Tap a cover to hear the song.");
    return p;
  }
  window.OkeArt = { el, row, put, src, credit };
})();
