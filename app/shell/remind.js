// Shared by the app's two pages (index.html, venue.html): the bar list, karaoke-night reminders and push.
// Reminders are local notifications scheduled on the phone from the bar's next start time, and are
// rescheduled every time the app opens, so a night the host cancels drops off once the app has seen it.
// Push (Firebase, see site/src/push_api.js) is turned on with the same switch: the phone's push token is
// registered with the bar on okenight.com ("karaoke is live", "your request is in"), and a host who enters
// the bar's host key also gets the host alerts. The token is registered again every time the app opens.
(function () {
  "use strict";
  const SITE = "https://okenight.com";
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const Notes = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  const NOTE_IDS = [101, 102];
  const TEST_ID = 199;

  // Minutes ahead of UTC at `ms` in time zone `tz` (0 if the phone can't tell). Used to keep next week's
  // reminder at the same wall-clock time when daylight saving time changes in between.
  function offset(ms, tz) {
    try {
      const p = {};
      new Intl.DateTimeFormat("en-US", { timeZone: tz, year: "numeric", month: "numeric", day: "numeric", hour: "numeric", minute: "numeric", hourCycle: "h23" })
        .formatToParts(new Date(ms)).forEach((x) => { p[x.type] = x.value; });
      return Date.UTC(+p.year, +p.month - 1, +p.day, +p.hour % 24, +p.minute) - Math.floor(ms / 60e3) * 60e3;
    } catch (e) { return 0; }
  }

  // ---------- push ----------
  const Push = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.FirebaseMessaging) || null;
  const platform = () => { try { return window.Capacitor.getPlatform(); } catch (e) { return ""; } };
  // The same random phone ID the singer page uses (localStorage "oke-device"), so "your request is in" finds this phone.
  function deviceId() {
    let d = null; try { d = localStorage.getItem("oke-device"); } catch (e) {}
    if (!/^[a-f0-9]{32}$/.test(d || "")) {
      const a = new Uint8Array(16); crypto.getRandomValues(a); d = [...a].map((x) => x.toString(16).padStart(2, "0")).join("");
      try { localStorage.setItem("oke-device", d); } catch (e) {}
    }
    return d;
  }
  let pushReady = false;
  function pushSetup() {
    const F = Push(); if (!F || pushReady) return; pushReady = true;
    if (platform() === "android") {
      F.createChannel({ id: "default", name: "Karaoke nights", description: "Karaoke is live, your song requests", importance: 4 }).catch(() => {});
      F.createChannel({ id: "host", name: "Host alerts", description: "Only for the host: secret songs, requests, the laptop, the line", importance: 5 }).catch(() => {});
    }
    // A new token (Firebase rotates them now and then): register it again.
    F.addListener("tokenReceived", () => { if (store.get("oke_app_remind")) pushRegister().catch(() => {}); });
    // Tapped: host alerts open the bar's host page in the browser, everything else opens the bar in the app.
    F.addListener("notificationActionPerformed", (ev) => {
      const d = (ev && ev.notification && ev.notification.data) || {};
      const slug = /^[a-z0-9-]+$/.test(d.venue || "") ? d.venue : store.get("oke_app_home");
      const path = String(d.path || "");
      if (slug && path && /^[a-z0-9?=&_-]+$/i.test(path)) { location.href = SITE + "/" + slug + "/" + path; return; }
      const v = (store.get("oke_app_venues") || []).find((x) => x.slug === slug);
      // Resolved against the page's own address, not the document's base: the bar page has
      // <base href="https://okenight.com/<bar>/">, so a bare "venue.html" would open okenight.com/<bar>/venue.html.
      if (v) { store.set("oke_app_venue", v); location.href = new URL("venue.html", location.href).href; }
    });
  }
  // Register this phone for push with the home bar. hostKey (optional) turns on the host alerts too.
  // Returns {ok, host} or {error: "app" | "bar" | "perm" | "token" | "net" | <the site's message>}.
  async function pushRegister(hostKey) {
    const F = Push(); if (!F) return { error: "app" };
    pushSetup();
    const home = store.get("oke_app_home");
    if (!home || home === "demo") return { error: "bar" };
    let p = { receive: "prompt" };
    try { p = await F.checkPermissions(); if (p.receive !== "granted") p = await F.requestPermissions(); } catch (e) {}
    if (p.receive !== "granted") return { error: "perm" };
    let token = "";
    try { token = (await F.getToken()).token || ""; } catch (e) {}
    if (!token) return { error: "token" };
    const body = { token, platform: platform(), dev: deviceId() };
    if (hostKey) body.host_key = hostKey; else body.host = "keep";
    try {
      const r = await fetch(SITE + "/" + home + "/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) });
      const j = await r.json().catch(() => ({}));
      if (!r.ok) return { error: j.error || "net" };
      store.set("oke_app_push", { token, home, host: !!j.host });
      return { ok: true, host: !!j.host };
    } catch (e) { return { error: "net" }; }
  }
  // Switch turned off: the site forgets this phone's token.
  async function pushOff() {
    const saved = store.get("oke_app_push"); store.set("oke_app_push", null);
    if (!saved || !saved.token) return;
    try { await fetch(SITE + "/" + saved.home + "/api/push", { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ token: saved.token, on: false }) }); } catch (e) {}
  }

  async function cancel() { const N = Notes(); if (N) try { await N.cancel({ notifications: NOTE_IDS.map((id) => ({ id })) }); } catch (e) {} }

  async function schedule() {
    const N = Notes(); if (!N) return;
    await cancel();
    if (!store.get("oke_app_remind")) return;
    const v = (store.get("oke_app_venues") || []).find((x) => x.slug === store.get("oke_app_home"));
    if (!v || !v.next_start) return;
    const now = Date.now(), first = v.next_start * 1000, out = [];
    const week = first + 7 * 86400e3, second = v.tz ? week + offset(first, v.tz) - offset(week, v.tz) : week;
    [first, second].forEach((start, i) => {
      const at = start - 3 * 3600e3; // three hours before
      let when = ""; try { when = new Date(start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: v.tz || undefined }); } catch (e) {}
      if (at > now + 60e3) out.push({ id: NOTE_IDS[i], title: "Karaoke tonight 🎤", body: v.name + (when ? " · starts " + when : "") + ". Open Oke Night to see who’s singing.", schedule: { at: new Date(at), allowWhileIdle: true } });
    });
    if (out.length) try { await N.schedule({ notifications: out }); } catch (e) {}
  }

  // A notification a few seconds from now, so a person (or App Review) can see reminders work.
  async function test() {
    const N = Notes(); if (!N) return false;
    try {
      await N.schedule({ notifications: [{ id: TEST_ID, title: "Karaoke tonight 🎤", body: "This is a test. Your real reminder comes a few hours before karaoke starts.", schedule: { at: new Date(Date.now() + 5000), allowWhileIdle: true } }] });
      return true;
    } catch (e) { return false; }
  }

  // Fresh bar list from the site (null when offline), saved for next time, then reminders rescheduled.
  async function refresh() {
    let list = null;
    try {
      const r = await fetch(SITE + "/api/venues", { cache: "no-store" });
      if (r.ok) list = ((await r.json()).venues || []).filter((v) => v && v.slug);
    } catch (e) {}
    if (list) store.set("oke_app_venues", list);
    await schedule();
    pushSetup();
    if (list && store.get("oke_app_remind")) pushRegister().catch(() => {}); // fresh token, and follows a change of bar
    return list;
  }

  window.OkeApp = { SITE, store, Notes, schedule, cancel, refresh, test, Push, pushRegister, pushOff };
})();
