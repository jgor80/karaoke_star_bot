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
    return list;
  }

  window.OkeApp = { SITE, store, Notes, schedule, cancel, refresh, test };
})();
