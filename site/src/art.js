// Album covers next to songs (phone page, Songbook and /tv). Covers come from /api/art (see art_api.js),
// which looks each song up once and remembers it. When it has none yet, the phone looks it up at Apple
// and reports the cover back (Apple blocks most lookups from Cloudflare's servers). Until a cover loads, or when a song has none, the
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
.art { position: relative; display: inline-block; flex: none; width: 56px; height: 56px; border-radius: 10px; overflow: hidden;
  background: linear-gradient(135deg, #3b1d4a, #1d0f24); box-shadow: inset 0 0 0 1px rgba(255,255,255,.08); vertical-align: middle; }
.art::before { content: "♪"; position: absolute; inset: 0; display: grid; place-items: center; color: rgba(255,255,255,.3); font-size: var(--art-note, 20px); }
.art img { position: absolute; inset: 0; width: 100%; height: 100%; object-fit: cover; opacity: 0; transition: opacity .3s; }
.art.ok img { opacity: 1; }
.art.ok { cursor: pointer; }
.art.ok::after { content: "▶"; position: absolute; right: 3px; bottom: 3px; width: 16px; height: 16px; border-radius: 50%;
  display: grid; place-items: center; font-size: 8px; color: #fff; background: rgba(0,0,0,.55); }
.art-credit { margin: 8px 2px 0; font-size: 15px; color: var(--muted, #a99); }
.art-credit a { color: inherit; }
.has-art { position: relative; padding-left: 84px !important; min-height: 76px; }
.has-art > .art { position: absolute; left: 14px; top: 50%; transform: translateY(-50%); }
.hero-art { display: flex; justify-content: center; }
.hero-art:empty { display: none; }
.hero-art .art { width: min(52vw, 210px); height: min(52vw, 210px); border-radius: 16px; box-shadow: 0 14px 36px rgba(0,0,0,.55), inset 0 0 0 1px rgba(255,255,255,.1); --art-note: 64px; }
`;
  const style = document.createElement("style"); style.textContent = css; document.head.append(style);

  // Must match norm() in art_api.js so every phone asks for the same URL and the edge cache answers.
  const normTitle = (s) => String(s || "").toLowerCase().normalize("NFKD").replace(/[\u0300-\u036f]/g, "").replace(/[^\p{L}\p{N}]+/gu, "").slice(0, 60);
  const idOf = (song) => Number(song && (song.song_id != null ? song.song_id : song.id)) || 0;
  const titleOf = (song) => (song && (song.title || song.t)) || "";
  const artistOf = (song) => (song && (song.artist || song.a)) || "";
  function src(song, big) {
    // a=1: Apple-only covers, so phones drop images cached from the old sources.
    return "api/art?a=1&id=" + idOf(song) + "&t=" + encodeURIComponent(normTitle(titleOf(song))) + (big ? "&s=big" : "");
  }

  // Covers that just failed (no cover, or the server said "busy"). Re-renders skip them for a while
  // instead of asking again every few seconds.
  const failed = new Map();
  const RETRY_MS = 10 * 60 * 1000;

  // Apple turns away most cover searches that come from Cloudflare's servers, so when the site has no
  // cover yet the phone asks Apple itself (each phone has its own allowance), shows what it finds, and
  // tells the site so every other phone gets it from okenight.com. Same rules as art_api.js.
  const plainTitle = (t) => String(t || "").replace(/\s*[([].*?[)\]]/g, "").replace(/\s+-\s+.*$/, "").trim() || String(t || "");
  const searchArtist = (a) => { const m = String(a || "").match(/\(([^()]+)\)\s*$/); return m && !/\b(film|movie|musical|soundtrack|tv|series|version)\b/i.test(m[1]) ? m[1] : String(a || "").replace(/\s*\(.*?\)/g, "").trim() || String(a || ""); };
  const mainArtist = (a) => String(searchArtist(a)).split(/\s+(?:feat\.?|ft\.?|featuring|vs\.?)\s+|\s*[,&/;]\s*|\s+and\s+/i)[0].trim() || String(a || "");
  function sameArtist(ours, theirs) {
    const a = normTitle(mainArtist(ours)).replace(/^the/, ""), b = normTitle(theirs).replace(/^the/, "");
    return !!a && !!b && (a.includes(b) || b.includes(a));
  }
  const FOUND = "oke-art-found";
  let found = {};
  try { found = JSON.parse(localStorage.getItem(FOUND) || "{}") || {}; } catch (e) {}
  const remember = (key, url) => {
    found[key] = [url, Date.now()];
    const keys = Object.keys(found); if (keys.length > 400) keys.sort((x, y) => found[x][1] - found[y][1]).slice(0, keys.length - 400).forEach((k) => delete found[k]);
    try { localStorage.setItem(FOUND, JSON.stringify(found)); } catch (e) {}
  };
  // One search at a time, at most ~15 a minute, so a long list doesn't trip Apple's limit for this phone.
  const queue = []; let busy = false, stamps = [], seq = 0, appleOff = 0;
  function pump() {
    if (busy || !queue.length) return;
    const now = Date.now(); stamps = stamps.filter((t) => now - t < 60000);
    if (stamps.length >= 15 || now < appleOff) { setTimeout(pump, 4000); return; }
    busy = true; stamps.push(now);
    const job = queue.shift();
    apple(job.song).then(job.done, () => { appleOff = Date.now() + 5 * 60000; job.done(null); }).finally(() => { busy = false; pump(); });
  }
  // JSONP: Apple's search API supports a callback, which works on every phone without CORS.
  function apple(song) {
    return new Promise((resolve, reject) => {
      const cb = "okeArt" + (++seq) + "_" + Date.now().toString(36);
      const term = mainArtist(artistOf(song)) + " " + plainTitle(titleOf(song));
      const sc = document.createElement("script");
      const end = (v, err) => { clearTimeout(t); delete window[cb]; sc.remove(); err ? reject(err) : resolve(v); };
      const t = setTimeout(() => end(null, new Error("timeout")), 8000);
      window[cb] = (d) => {
        const hit = ((d && d.results) || []).find((x) => x.artworkUrl100 && sameArtist(artistOf(song), x.artistName));
        end(hit ? { url: hit.artworkUrl100.replace(/\/\d+x\d+bb\./, "/300x300bb."), link: hit.trackViewUrl || hit.collectionViewUrl || "", artist: hit.artistName } : null);
      };
      sc.onerror = () => end(null, new Error("blocked"));
      sc.src = "https://itunes.apple.com/search?media=music&entity=song&limit=10&callback=" + cb + "&term=" + encodeURIComponent(term);
      document.head.append(sc);
    });
  }
  const pending = new Map();
  function lookup(song) {
    const k = idOf(song) + "|" + normTitle(titleOf(song));
    if (!pending.has(k)) pending.set(k, new Promise((done) => { queue.push({ song, done }); pump(); }).then((hit) => {
      if (hit) {
        remember(k, hit.url);
        fetch("api/art", { method: "POST", headers: { "content-type": "application/json" }, keepalive: true,
          body: JSON.stringify({ id: idOf(song), t: normTitle(titleOf(song)), url: hit.url, link: hit.link, artist: hit.artist }) }).catch(() => {});
      }
      return hit;
    }));
    return pending.get(k);
  }
  const bigUrl = (u, big) => (big ? u.replace(/\/300x300bb\./, "/600x600bb.") : u);

  function el(song, opts) {
    opts = opts || {};
    const box = document.createElement("span");
    box.className = "art" + (opts.cls ? " " + opts.cls : "");
    box.setAttribute("aria-hidden", "true");
    const base = idOf(song) + "|" + normTitle(titleOf(song));
    const key = base + (opts.big ? "|b" : "");
    if (idOf(song) > 0 && titleOf(song) && !(Date.now() - (failed.get(key) || 0) < RETRY_MS)) {
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
      let asked = false;
      img.onerror = () => {
        if (asked || !artistOf(song)) { failed.set(key, Date.now()); img.remove(); return; }
        asked = true;
        lookup(song).then((hit) => { if (hit) img.src = bigUrl(hit.url, opts.big); else { failed.set(key, Date.now()); img.remove(); } });
      };
      const mine = found[base];
      img.src = mine && Date.now() - mine[1] < 7 * 86400000 ? bigUrl(mine[0], opts.big) : src(song, opts.big);
      if (mine) asked = true;
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
