// Shared by the app's two pages (index.html, venue.html): the bar list and karaoke-night reminders.
// Reminders are local notifications scheduled on the phone from the bar's next start time, and are
// rescheduled every time the app opens, so a night the host cancels drops off once the app has seen it.
(function () {
  "use strict";
  const SITE = "https://okenight.com";
  const store = {
    get(k) { try { return JSON.parse(localStorage.getItem(k) || "null"); } catch (e) { return null; } },
    set(k, v) { try { localStorage.setItem(k, JSON.stringify(v)); } catch (e) {} },
  };
  const Notes = () => (window.Capacitor && window.Capacitor.Plugins && window.Capacitor.Plugins.LocalNotifications) || null;
  const NOTE_IDS = [101, 102];

  async function cancel() { const N = Notes(); if (N) try { await N.cancel({ notifications: NOTE_IDS.map((id) => ({ id })) }); } catch (e) {} }

  async function schedule() {
    const N = Notes(); if (!N) return;
    await cancel();
    if (!store.get("oke_app_remind")) return;
    const v = (store.get("oke_app_venues") || []).find((x) => x.slug === store.get("oke_app_home"));
    if (!v || !v.next_start) return;
    const now = Date.now(), first = v.next_start * 1000, out = [];
    [first, first + 7 * 86400e3].forEach((start, i) => {
      const at = start - 3 * 3600e3; // three hours before
      let when = ""; try { when = new Date(start).toLocaleTimeString([], { hour: "numeric", minute: "2-digit", timeZone: v.tz || undefined }); } catch (e) {}
      if (at > now + 60e3) out.push({ id: NOTE_IDS[i], title: "Karaoke tonight 🎤", body: v.name + (when ? " · starts " + when : "") + ". Open Oke Night to see who’s singing.", schedule: { at: new Date(at), allowWhileIdle: true } });
    });
    if (out.length) try { await N.schedule({ notifications: out }); } catch (e) {}
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
    return list;
  }

  window.OkeApp = { SITE, store, Notes, schedule, cancel, refresh };
})();
